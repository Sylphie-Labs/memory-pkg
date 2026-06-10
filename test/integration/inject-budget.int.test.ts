/**
 * inject-budget.int.test.ts -- T5 integration test (real TimescaleDB).
 *
 * Exercises generateInjection()'s budget and hygiene rules:
 *   - char budget: the rendered block stays within MAX_TOTAL_CHARS + tag overhead.
 *   - count limit: an explicit limit produces exactly that many ### Match blocks.
 *   - tool_result rows are excluded from the injected block.
 *   - a matching row with a NULL excerpt is never rendered as an empty block.
 *   - a query that matches nothing returns '' exactly (no whitespace, no tags).
 *   - a row whose search_text matches the query IS surfaced.
 *
 * Determinism: only the trigram (DB-lexical) tier runs. The entity and embedding
 * tiers are disabled via env so what surfaces depends solely on seeded
 * search_text — no local model load, no transcript dependency. Rerank stays off
 * (default), so ambiguous rows pass through without a Haiku call.
 *
 * Skips gracefully when no TimescaleDB is reachable (createTestDb throws in
 * beforeAll): every `it` guards itself with ctx.skip() at runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool } from '../../src/timescale-client.js';
import { generateInjection } from '../../src/inject/generate.js';

const MATCH_QUERY = 'budget test keyword unique';
const NOMATCH_QUERY = 'absolutely_no_match_9z9z9z';

// A row whose search_text equals this string surfaces only when the query is
// this string — proves matching still works for a non-budget query.
const SMALL_MATCH_SEARCH = 'zzqx_nomatch_xqzz';
const SMALL_MATCH_EXCERPT = 'small match';

const TOOL_RESULT_EXCERPT = 'tool_result_excerpt_should_never_be_injected';
const BIG_EXCERPT = 'x'.repeat(900);

let db: TestDb | undefined;

/**
 * Run fn against the test DB's env with only the trigram tier active. The
 * singleton pool caches its connection config on the first getPool(); resetting
 * it inside the env scope forces resolution against the throwaway database.
 */
async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  return withEnvAsync(db!.env, async () => {
    await closePool();
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

beforeAll(async () => {
  if (!db) return;
  await withDb(() =>
    seedEvents(db!.env, [
      // 10 strong-matching tool_call rows, each a 900-char excerpt.
      ...Array.from({ length: 10 }, (_, i) => ({
        session_id: `budget-sess-${i}`,
        event_type: 'tool_call',
        search_text: MATCH_QUERY,
        excerpt: BIG_EXCERPT,
        summary: '',
      })),
      // A tool_result row that matches lexically but must be excluded.
      {
        session_id: 'budget-tool-result',
        event_type: 'tool_result',
        search_text: MATCH_QUERY,
        excerpt: TOOL_RESULT_EXCERPT,
        summary: '',
      },
      // A matching tool_call row with a NULL excerpt — must never render as an
      // empty match block.
      {
        session_id: 'budget-null-excerpt',
        event_type: 'tool_call',
        search_text: MATCH_QUERY,
        excerpt: null,
        summary: '',
      },
      // search_text equals SMALL_MATCH_SEARCH — surfaces only for that query.
      {
        session_id: 'budget-small-match',
        event_type: 'tool_call',
        search_text: SMALL_MATCH_SEARCH,
        excerpt: SMALL_MATCH_EXCERPT,
        summary: '',
      },
    ]),
  );
});

describe('T5 inject budget and hygiene (integration)', () => {
  it(
    'keeps the rendered block within the char budget (+ tag overhead)',
    async (ctx) => {
      if (!db) return ctx.skip();
      const result = await withDb(() => generateInjection({ query: MATCH_QUERY }));
      expect(result.length).toBeLessThanOrEqual(4200);
    },
  );

  it('honors an explicit limit of 2 (exactly two ### Match blocks)', async (ctx) => {
    if (!db) return ctx.skip();
    const result = await withDb(() => generateInjection({ query: MATCH_QUERY, limit: 2 }));
    const matches = result.match(/### Match/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('excludes tool_result rows from the injected block', async (ctx) => {
    if (!db) return ctx.skip();
    // limit 10 so the tool_result row would be reached if it were eligible.
    const result = await withDb(() => generateInjection({ query: MATCH_QUERY, limit: 10 }));
    expect(result).not.toContain(TOOL_RESULT_EXCERPT);
    expect(result).not.toContain('budget-tool-result');
  });

  it('never renders a null-excerpt match as an empty block', async (ctx) => {
    if (!db) return ctx.skip();
    const result = await withDb(() => generateInjection({ query: MATCH_QUERY, limit: 10 }));
    // The null-excerpt row's session marker must not surface...
    expect(result).not.toContain('budget-null-excerpt');
    // ...and there must be no match heading immediately followed by an empty
    // body (heading-then-heading or heading-then-close with no content line).
    const emptyBlock = /### Match[^\n]*\n\s*(?=### Match|<\/memory-context>)/;
    expect(emptyBlock.test(result)).toBe(false);
  });

  it("returns '' (exactly) for a query that matches nothing", async (ctx) => {
    if (!db) return ctx.skip();
    const result = await withDb(() => generateInjection({ query: NOMATCH_QUERY }));
    expect(result).toBe('');
  });

  it('surfaces a row whose search_text matches the query exactly', async (ctx) => {
    if (!db) return ctx.skip();
    const result = await withDb(() => generateInjection({ query: SMALL_MATCH_SEARCH }));
    expect(result).toContain('### Match');
    expect(result).toContain(SMALL_MATCH_EXCERPT);
  });
});
