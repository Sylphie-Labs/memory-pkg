/**
 * self-exclusion.int.test.ts -- T3 integration test (real TimescaleDB).
 *
 * Verifies the session self-exclusion semantics of the two retrieval surfaces:
 *
 *   - generateInjection(excludeSelf) filters AWAY the current session, so the
 *     live model never sees its own in-flight session echoed back as "memory."
 *   - searchMemory(sessionId) filters TO a session — the opposite direction:
 *     an explicit include-filter, used when the model deliberately asks for one
 *     session's history.
 *
 * Two sessions ('sess-mine', 'sess-other') are seeded with identical
 * high-similarity content so any difference in what surfaces is attributable to
 * the session filter alone, not to relevance scoring.
 *
 * Skips gracefully when no TimescaleDB is reachable (createTestDb throws in
 * beforeAll): every `it` guards itself with ctx.skip() at runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool } from '../../src/timescale-client.js';
import { generateInjection } from '../../src/inject/generate.js';
import { handleSearchMemory } from '../../src/mcp-server/tools/searchMemory.js';

// Identical content across both sessions — exact match drives the trigram tier
// to a ~1.0 word_similarity, so the fast path is "strong" and the rescue
// embedding tier never runs (no local model load needed).
const CONTENT = 'stripe webhook payment signature validation middleware fix';
const MINE = 'sess-mine';
const OTHER = 'sess-other';

let db: TestDb | undefined;

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    // No DB reachable — leave db undefined; every test self-skips at runtime.
    db = undefined;
  }
});

afterAll(async () => {
  if (db) {
    await closePool();
    await db.drop();
  }
});

/**
 * Run fn against the test DB's env. The singleton pool caches its connection
 * config on the first getPool(); resetting it inside the env scope forces it to
 * resolve against the throwaway database rather than whatever a prior test left.
 */
async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  return withEnvAsync(db!.env, async () => {
    await closePool();
    // Keep the embedding + entity tiers out of the way: the trigram tier alone
    // exercises excludeSelf, and disabling the others removes any model-load /
    // transcript dependency and keeps results deterministic.
    process.env.DRIFT_MEMORY_TIER_EMBEDDING_DISABLED = '1';
    process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED = '1';
    try {
      return await fn();
    } finally {
      delete process.env.DRIFT_MEMORY_TIER_EMBEDDING_DISABLED;
      delete process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED;
      await closePool();
    }
  });
}

beforeAll(async () => {
  if (!db) return;
  // Excerpts are tagged with the session so the rendered/returned strings can be
  // asserted by substring. ts differs by 1s so ORDER BY ts is well-defined.
  await withDb(() =>
    seedEvents(db!.env, [
      {
        session_id: MINE,
        event_type: 'tool_call',
        search_text: CONTENT,
        excerpt: `${CONTENT} [from ${MINE}]`,
        summary: `${CONTENT} [from ${MINE}]`,
        ts: '2026-01-01T00:00:00.000Z',
      },
      {
        session_id: OTHER,
        event_type: 'tool_call',
        search_text: CONTENT,
        excerpt: `${CONTENT} [from ${OTHER}]`,
        summary: `${CONTENT} [from ${OTHER}]`,
        ts: '2026-01-01T00:00:01.000Z',
      },
    ]),
  );
});

describe('T3 self-exclusion (integration)', () => {
  const mineMarker = `[from ${MINE}]`;
  const otherMarker = `[from ${OTHER}]`;

  it(
    'generateInjection excludeSelf=true (default) drops the current session, keeps others',
    async (ctx) => {
      if (!db) return ctx.skip();
      const result = await withDb(() =>
        generateInjection({ query: CONTENT, currentSessionId: MINE }),
      );
      expect(result).toContain(otherMarker);
      expect(result).not.toContain(mineMarker);
    },
  );

  it(
    'generateInjection excludeSelf=false includes both sessions',
    async (ctx) => {
      if (!db) return ctx.skip();
      const result = await withDb(() =>
        generateInjection({ query: CONTENT, currentSessionId: MINE, excludeSelf: false }),
      );
      expect(result).toContain(mineMarker);
      expect(result).toContain(otherMarker);
    },
  );

  it(
    'generateInjection from sess-other excludes only sess-other',
    async (ctx) => {
      if (!db) return ctx.skip();
      const result = await withDb(() =>
        generateInjection({ query: CONTENT, currentSessionId: OTHER }),
      );
      expect(result).toContain(mineMarker);
      expect(result).not.toContain(otherMarker);
    },
  );

  it(
    'searchMemory(sessionId) filters TO the session (opposite of excludeSelf)',
    async (ctx) => {
      if (!db) return ctx.skip();
      const result = await withDb(() =>
        handleSearchMemory({ query: CONTENT, sessionId: MINE }),
      );
      // Include-filter: only the named session's rows come back.
      expect(result).toContain(MINE);
      expect(result).not.toContain(OTHER);
    },
  );
});
