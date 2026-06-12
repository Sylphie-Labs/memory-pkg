/**
 * consolidate.int.test.ts -- Phase 1 consolidation runner against a real
 * TimescaleDB. Skips gracefully when no DB is reachable (createTestDb throws in
 * beforeAll; each it() guards with ctx.skip()).
 *
 * Uses an injected processor list of [ingestFlushProcessor] so it never spawns
 * the real `claude` CLI (the rationale processor is covered separately by
 * synthesize's own tests). This exercises the real lock → processor → DB path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool, runQuery } from '../../src/timescale-client.js';
import { runConsolidation } from '../../src/consolidate/runner.js';
import { getMeta } from '../../src/consolidate/meta.js';
import { ingestFlushProcessor } from '../../src/consolidate/processors/ingest-flush.js';

const { Client } = pg;

let db: TestDb | undefined;
let bufferDir: string;

function env(): Record<string, string> {
  return { ...db!.env, MEMORY_PKG_EMBED_FAKE: '1' };
}

async function countRows(): Promise<number> {
  const c = new Client({
    host: db!.env.MEMORY_PKG_PG_HOST,
    port: parseInt(db!.env.MEMORY_PKG_PG_PORT, 10),
    user: db!.env.MEMORY_PKG_PG_USER,
    password: db!.env.MEMORY_PKG_PG_PASSWORD,
    database: db!.env.MEMORY_PKG_PG_DATABASE,
  });
  await c.connect();
  try {
    const r = await c.query('SELECT count(*)::int AS n FROM memory_events');
    return r.rows[0].n as number;
  } finally {
    await c.end();
  }
}

function writeBuffer(lines: object[]): void {
  writeFileSync(
    path.join(bufferDir, 'buffer.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    return;
  }
  bufferDir = mkdtempSync(path.join(tmpdir(), 'mpkg-consol-int-'));
});

afterAll(async () => {
  await closePool();
  await db?.drop();
  if (bufferDir) rmSync(bufferDir, { recursive: true, force: true });
});

const TS = '2026-04-01T10:00:00.000Z';

describe('consolidate runner (integration)', () => {
  it('ingest-flush processor ingests the buffer end-to-end, idempotently', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      writeBuffer([
        { ts: TS, session_id: 'cs1', event_type: 'user_prompt', excerpt: 'hello', transcript_uuid: 'c1:0' },
        { ts: TS, session_id: 'cs1', event_type: 'assistant_text', excerpt: 'world', transcript_uuid: 'c1:1' },
      ]);

      const r = await runConsolidation({
        bufferDir,
        sessionId: 'cs1',
        processors: [ingestFlushProcessor],
      });
      expect(r.ran).toBe(true);
      const flush = r.processors.find((p) => p.name === 'ingest-flush');
      expect(flush?.processed).toBe(2);
      expect(await countRows()).toBe(2);
      // Buffer consumed.
      expect(existsSync(path.join(bufferDir, 'buffer.jsonl'))).toBe(false);

      // Re-running with no new buffer inserts nothing.
      const r2 = await runConsolidation({ bufferDir, sessionId: 'cs1', processors: [ingestFlushProcessor] });
      expect(r2.processors.find((p) => p.name === 'ingest-flush')?.processed).toBe(0);
      expect(await countRows()).toBe(2);
    });
  });

  it('deep pass stamps deep_last_ran_at and --if-stale then no-ops', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      const r = await runConsolidation({ deep: true, bufferDir, processors: [ingestFlushProcessor] });
      expect(r.ran).toBe(true);
      expect(r.deep).toBe(true);

      const stamp = await getMeta('deep_last_ran_at');
      expect(stamp).toBeTruthy();

      // Immediately re-running with a 24h staleness guard must no-op.
      const r2 = await runConsolidation({
        deep: true,
        bufferDir,
        ifStaleHours: 24,
        processors: [ingestFlushProcessor],
      });
      expect(r2.ran).toBe(false);
      expect(r2.skipped).toBe('fresh');
    });
  });

  it('pooled connections carry the lowered word_similarity threshold (B1 enabler)', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      const rows = await runQuery<Record<string, string>>('SHOW pg_trgm.word_similarity_threshold');
      expect(rows[0]['pg_trgm.word_similarity_threshold']).toBe('0.2');
    });
  });

  it('the `<%` operator form matches the same rows as the explicit floor', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      // Seed a row whose search_text shares a strong word with the query.
      writeBuffer([
        {
          ts: TS,
          session_id: 'cs2',
          event_type: 'assistant_text',
          excerpt: 'the FilterBar date picker reset bug',
          search_text: 'assistant_text the FilterBar date picker reset bug',
          transcript_uuid: 'c2:0',
        },
      ]);
      await runConsolidation({ bufferDir, sessionId: 'cs2', processors: [ingestFlushProcessor] });

      const rows = await runQuery<{ event_id: string; score: number }>(
        `SELECT event_id, word_similarity($1, search_text) AS score
         FROM memory_events
         WHERE event_type <> 'tool_result'
           AND $1 <% search_text
           AND word_similarity($1, search_text) >= 0.2
         ORDER BY score DESC`,
        ['FilterBar'],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(Number(rows[0].score)).toBeGreaterThanOrEqual(0.2);
    });
  });
});
