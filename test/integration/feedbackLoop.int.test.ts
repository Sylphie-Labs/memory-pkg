/**
 * feedbackLoop.int.test.ts -- Phase 4 acceptance: the feedback loop closes.
 *
 * inject (persist) → memory_injections row + ledger + injection id in block
 *   → rateMemoryInjections writes memory_ratings
 *   → stats-fold populates memory_event_stats
 *   → the NEXT injection of that event carries a non-1.0 shadow multiplier.
 *
 * Runs against a real TimescaleDB (schema v3); skips when no DB is reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool, runQuery } from '../../src/timescale-client.js';
import { generateInjection } from '../../src/inject/generate.js';
import { handleRateMemoryInjections } from '../../src/mcp-server/tools/rateMemoryInjections.js';
import { runConsolidation } from '../../src/consolidate/runner.js';
import { statsFoldProcessor } from '../../src/consolidate/processors/stats-fold.js';

let db: TestDb | undefined;
let project: string;

const EVT_ID = '44444444-4444-4444-4444-444444444444';
const SESSION = 'fb-session';

function env(): Record<string, string> {
  return { ...db!.env, MEMORY_PKG_EMBED_FAKE: '1', CLAUDE_PROJECT_DIR: project };
}

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    return;
  }
  project = mkdtempSync(path.join(tmpdir(), 'mpkg-fb-'));
  await withEnvAsync(env(), async () => {
    await closePool();
    await seedEvents(db!.env, [
      {
        event_id: EVT_ID,
        ts: '2026-05-10T10:00:00.000Z',
        session_id: 'past-session',
        event_type: 'assistant_text',
        summary: 'the DatePicker reset bug was fixed in FilterBar',
        excerpt: 'the DatePicker reset bug was fixed in FilterBar',
        search_text: 'assistant_text the DatePicker reset bug was fixed in FilterBar',
      },
    ]);
    await closePool();
  });
});

afterAll(async () => {
  await closePool();
  await db?.drop();
  if (project) rmSync(project, { recursive: true, force: true });
});

function injectionIdFromBlock(block: string): string | null {
  const m = block.match(/^injection: ([0-9a-f-]{36})$/m);
  return m ? m[1] : null;
}

describe('feedback loop (Phase 4)', () => {
  it('closes: inject → persist → rate → fold → shadow multiplier moves', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      // 1. Inject (persist). The block carries an injection id; a row + ledger land.
      const block1 = await generateInjection({
        query: 'tell me about the DatePicker reset bug',
        currentSessionId: SESSION,
        persistInjection: true,
      });
      expect(block1).toContain('DatePicker');
      const injectionId = injectionIdFromBlock(block1);
      expect(injectionId).toBeTruthy();

      const inj = await runQuery<{ item_ids: string[]; shadow_scores: any }>(
        `SELECT item_ids, shadow_scores FROM memory_injections WHERE injection_id = $1`,
        [injectionId],
      );
      expect(inj.length).toBe(1);
      expect(inj[0].item_ids).toContain(EVT_ID);
      // First injection: no ratings yet → shadow multiplier is 1.0.
      expect(inj[0].shadow_scores[EVT_ID].multiplier).toBeCloseTo(1.0, 5);

      // Ledger sidecar written.
      const ledger = path.join(project, '.claude', 'memory', 'injections', `${SESSION}.jsonl`);
      expect(existsSync(ledger)).toBe(true);
      expect(readFileSync(ledger, 'utf8')).toContain(injectionId!);

      // 2. Rate it +1 via the MCP tool.
      await handleRateMemoryInjections({
        injection_id: injectionId!,
        ratings: [{ event_id: EVT_ID, rating: 1 }],
        session_id: SESSION,
      });
      const ratings = await runQuery<{ rating: number }>(
        `SELECT rating FROM memory_ratings WHERE injection_id = $1 AND item_id = $2`,
        [injectionId, EVT_ID],
      );
      expect(ratings.length).toBe(1);
      expect(ratings[0].rating).toBe(1);

      // 3. Fold stats.
      await runConsolidation({ deep: true, processors: [statsFoldProcessor] });
      const stats = await runQuery<{ n_self: number; sum_self: number }>(
        `SELECT n_self, sum_self FROM memory_event_stats WHERE item_id = $1`,
        [EVT_ID],
      );
      expect(stats.length).toBe(1);
      expect(stats[0].n_self).toBe(1);
      expect(stats[0].sum_self).toBe(1);

      // 4. Re-inject: shadow multiplier now reflects the +1 (> 1.0).
      const block2 = await generateInjection({
        query: 'tell me about the DatePicker reset bug again',
        currentSessionId: SESSION,
        persistInjection: true,
      });
      const injectionId2 = injectionIdFromBlock(block2);
      const inj2 = await runQuery<{ shadow_scores: any }>(
        `SELECT shadow_scores FROM memory_injections WHERE injection_id = $1`,
        [injectionId2],
      );
      expect(inj2[0].shadow_scores[EVT_ID].multiplier).toBeGreaterThan(1.0);
    });
  });

  it('rateMemoryInjections coerces ratings and is idempotent', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      const id = '55555555-5555-5555-5555-555555555555';
      await handleRateMemoryInjections({ injection_id: id, ratings: [{ event_id: EVT_ID, rating: 9 }] });
      await handleRateMemoryInjections({ injection_id: id, ratings: [{ event_id: EVT_ID, rating: 9 }] });
      const rows = await runQuery<{ rating: number }>(
        `SELECT rating FROM memory_ratings WHERE injection_id = $1 AND source = 'self'`,
        [id],
      );
      expect(rows.length).toBe(1); // ON CONFLICT dedupe
      expect(rows[0].rating).toBe(1); // 9 coerced to +1
    });
  });
});
