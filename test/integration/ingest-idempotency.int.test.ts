/**
 * ingest-idempotency.int.test.ts -- T2: ingest idempotency + multi-block dedup.
 *
 * Requires a real TimescaleDB (the dev docker-compose, or MEMORY_PKG_PG_* env
 * pointing at one). The whole suite skips gracefully when no DB is reachable:
 * createTestDb() is wrapped in try/catch in beforeAll, and every it() guards at
 * runtime with `if (!db) return ctx.skip()`. (it.skipIf can't be used here — its
 * condition is read at collection time, before beforeAll sets `db`.)
 *
 * Events are written straight to the buffer.jsonl that ingest({ bufferDir })
 * reads, exercising the real rotate → parse → insertBatch path including the
 * (session_id, transcript_uuid, ts) unique index and ON CONFLICT DO NOTHING.
 *
 * MEMORY_PKG_EMBED_FAKE is set in the borrowed env so events carrying excerpt
 * text get a hash-based fake vector instead of warm-loading the 90MB ONNX model.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createTestDb, withEnvAsync } from '../helpers/db.js';
import { ingest } from '../../src/ingest/ingester.js';
import { closePool } from '../../src/timescale-client.js';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { TestDb } from '../helpers/db.js';

const { Client } = pg;

let db: TestDb | undefined;
let bufferDir: string;

// The DB env augmented with the fake-embed flag so insertBatch never reaches
// for the real model when an event carries text.
function runEnv(): Record<string, string> {
  return { ...db!.env, MEMORY_PKG_EMBED_FAKE: '1' };
}

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    // DB unavailable — tests will be skipped individually.
    return;
  }
  bufferDir = mkdtempSync(path.join(tmpdir(), 'mpkg-test-'));
});

afterAll(async () => {
  await db?.drop();
  if (bufferDir) rmSync(bufferDir, { recursive: true, force: true });
});

/** Write the given events as buffer.jsonl in bufferDir (one JSON object/line). */
function writeBuffer(lines: object[]): void {
  writeFileSync(
    path.join(bufferDir, 'buffer.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

/** Count rows in memory_events, optionally filtered by session_id. */
async function countRows(
  env: Record<string, string>,
  sessionId?: string,
): Promise<number> {
  const client = new Client({
    host: env.MEMORY_PKG_PG_HOST,
    port: parseInt(env.MEMORY_PKG_PG_PORT, 10),
    user: env.MEMORY_PKG_PG_USER,
    password: env.MEMORY_PKG_PG_PASSWORD,
    database: env.MEMORY_PKG_PG_DATABASE,
  });
  await client.connect();
  try {
    const res = sessionId
      ? await client.query(
          'SELECT count(*)::int AS n FROM memory_events WHERE session_id = $1',
          [sessionId],
        )
      : await client.query('SELECT count(*)::int AS n FROM memory_events');
    return res.rows[0].n as number;
  } finally {
    await client.end();
  }
}

/** TRUNCATE memory_events so each case starts from a clean slate. */
async function clearEvents(env: Record<string, string>): Promise<void> {
  const client = new Client({
    host: env.MEMORY_PKG_PG_HOST,
    port: parseInt(env.MEMORY_PKG_PG_PORT, 10),
    user: env.MEMORY_PKG_PG_USER,
    password: env.MEMORY_PKG_PG_PASSWORD,
    database: env.MEMORY_PKG_PG_DATABASE,
  });
  await client.connect();
  try {
    await client.query('DELETE FROM memory_events');
  } finally {
    await client.end();
  }
}

const TS = '2026-03-01T12:00:00.000Z';

describe('ingest idempotency + multi-block dedup (T2)', () => {
  // NB: it.skipIf is evaluated at collection time, before beforeAll runs, so
  // `db` would always be undefined there. Guard at runtime with ctx.skip().
  it('Case A — re-ingesting the same buffer inserts each event exactly once', async (ctx) => {
    if (!db) return ctx.skip();
    {
      const env = runEnv();
      await clearEvents(env);

      const session = 'sessA';
      const events = [
        {
          ts: TS,
          session_id: session,
          event_type: 'user_prompt',
          excerpt: 'first event',
          transcript_uuid: 'u1:0',
        },
        {
          ts: TS,
          session_id: session,
          event_type: 'assistant_text',
          excerpt: 'second event',
          transcript_uuid: 'u1:1',
        },
        {
          ts: TS,
          session_id: session,
          event_type: 'tool_use',
          tool_name: 'Read',
          file_path: 'a.ts',
          excerpt: 'third event',
          transcript_uuid: 'u1:2',
        },
      ];

      writeBuffer(events);
      const first = await withEnvAsync(env, () => ingest({ bufferDir }));
      expect(first.inserted).toBe(3);
      expect(await countRows(env, session)).toBe(3);

      // Simulate a cursor reset: the exact same batch arrives again.
      writeBuffer(events);
      await withEnvAsync(env, () => ingest({ bufferDir }));

      // ON CONFLICT DO NOTHING on (session_id, transcript_uuid, ts) keeps it at 3.
      expect(await countRows(env, session)).toBe(3);
    }
  });

  it('Case B — distinct transcript_uuids insert separately; a shared uuid+ts dedups to one', async (ctx) => {
    if (!db) return ctx.skip();
    {
      const env = runEnv();
      await clearEvents(env);

      // Three distinct uuids -> three rows.
      const distinct = ['u2:0', 'u2:1', 'u2:2'].map((uuid, i) => ({
        ts: TS,
        session_id: 'sessB',
        event_type: 'assistant_text',
        excerpt: `block ${i}`,
        transcript_uuid: uuid,
      }));
      writeBuffer(distinct);
      await withEnvAsync(env, () => ingest({ bufferDir }));
      expect(await countRows(env, 'sessB')).toBe(3);

      // Two rows sharing the same bare uuid AND ts collide on the unique index
      // (session_id, transcript_uuid, ts) -> only one survives.
      const collide = [0, 1].map((i) => ({
        ts: TS,
        session_id: 'sessB',
        event_type: 'assistant_text',
        excerpt: `dup ${i}`,
        transcript_uuid: 'u3',
      }));
      writeBuffer(collide);
      await withEnvAsync(env, () => ingest({ bufferDir }));

      // 3 distinct + 1 of the colliding pair = 4.
      expect(await countRows(env, 'sessB')).toBe(4);
    }
  });

  it('Case C — a failed ingest dead-letters the batch; retryFailed re-ingests it', async (ctx) => {
    if (!db) return ctx.skip();
    {
      const goodEnv = runEnv();
      await clearEvents(goodEnv);

      const session = 'sessC';
      const events = [
        {
          ts: TS,
          session_id: session,
          event_type: 'user_prompt',
          excerpt: 'needs retry',
          transcript_uuid: 'uC:0',
        },
        {
          ts: TS,
          session_id: session,
          event_type: 'assistant_text',
          excerpt: 'also needs retry',
          transcript_uuid: 'uC:1',
        },
      ];

      // Point at a database that does not exist so insertBatch throws.
      const brokenEnv = {
        ...goodEnv,
        MEMORY_PKG_PG_DATABASE: 'memory_test_does_not_exist_zzz',
      };
      const failedFile = path.join(bufferDir, 'buffer.failed.jsonl');

      writeBuffer(events);
      await expect(
        withEnvAsync(brokenEnv, async () => {
          // The timescale-client pool is a singleton resolved on first use; it
          // was already built against the real DB by earlier cases. Reset it so
          // ingest re-resolves getPool() against brokenEnv and actually fails.
          await closePool();
          try {
            return await ingest({ bufferDir });
          } finally {
            // Drop the broken pool so the retry below resolves against the real DB.
            await closePool();
          }
        }),
      ).rejects.toThrow();

      // Batch was dead-lettered, not silently dropped, and the live buffer is gone.
      expect(existsSync(failedFile)).toBe(true);
      expect(existsSync(path.join(bufferDir, 'buffer.jsonl'))).toBe(false);
      expect(await countRows(goodEnv, session)).toBe(0);

      // Retry against the real DB: the dead-letter file is re-queued and ingested.
      const retried = await withEnvAsync(goodEnv, () =>
        ingest({ bufferDir, retryFailed: true }),
      );
      expect(retried.inserted).toBe(2);
      expect(await countRows(goodEnv, session)).toBe(2);
      expect(existsSync(failedFile)).toBe(false);
    }
  });
});
