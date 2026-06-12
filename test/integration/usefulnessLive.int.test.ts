/**
 * usefulnessLive.int.test.ts -- Phase 6: the usefulness multiplier, live.
 *
 * Two equally-matching memories (identical search_text) differ only in rating
 * history. With MEMORY_PKG_USEFULNESS_LIVE unset, base score decides order;
 * with it set, the multiplier flips them. Also checks the rating-mean processor.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool, runQuery } from '../../src/timescale-client.js';
import { generateInjection } from '../../src/inject/generate.js';
import { runConsolidation } from '../../src/consolidate/runner.js';
import { ratingMeanProcessor } from '../../src/consolidate/processors/rating-mean.js';
import { getMeta } from '../../src/consolidate/meta.js';

let db: TestDb | undefined;

const A = '77777777-aaaa-7777-aaaa-777777777777'; // higher ts, NEGATIVE ratings
const B = '88888888-bbbb-8888-bbbb-888888888888'; // lower ts, POSITIVE ratings
const ST = 'the GammaWidget reset flow handler';

function env(): Record<string, string> {
  return { ...db!.env, MEMORY_PKG_EMBED_FAKE: '1' };
}

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    return;
  }
  await withEnvAsync(env(), async () => {
    await closePool();
    await seedEvents(db!.env, [
      { event_id: A, ts: '2026-05-10T10:02:00.000Z', session_id: 'past', event_type: 'assistant_text',
        summary: 'AAA excerpt', excerpt: 'AAA excerpt', search_text: `assistant_text ${ST}` },
      { event_id: B, ts: '2026-05-10T10:01:00.000Z', session_id: 'past', event_type: 'assistant_text',
        summary: 'BBB excerpt', excerpt: 'BBB excerpt', search_text: `assistant_text ${ST}` },
    ]);
    const recent = new Date().toISOString();
    await runQuery(
      `INSERT INTO memory_event_stats (item_id, n_self, sum_self, last_rated_at)
       VALUES ($1, 3, -3, $3), ($2, 3, 3, $3)`,
      [A, B, recent],
    );
    await closePool();
  });
});

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('usefulness multiplier live (Phase 6)', () => {
  it('shadow (default): base score order — A (later ts) before B', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      const block = await generateInjection({ query: 'GammaWidget reset flow', currentSessionId: 'cur' });
      const ai = block.indexOf('AAA excerpt');
      const bi = block.indexOf('BBB excerpt');
      expect(ai).toBeGreaterThanOrEqual(0);
      expect(bi).toBeGreaterThanOrEqual(0);
      expect(ai).toBeLessThan(bi); // A first
    });
  });

  it('live: the multiplier flips it — B (+1, ×1.3) outranks A (−1, ×0.7)', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync({ ...env(), MEMORY_PKG_USEFULNESS_LIVE: '1' }, async () => {
      const block = await generateInjection({ query: 'GammaWidget reset flow', currentSessionId: 'cur' });
      const ai = block.indexOf('AAA excerpt');
      const bi = block.indexOf('BBB excerpt');
      expect(bi).toBeGreaterThanOrEqual(0);
      expect(ai).toBeGreaterThanOrEqual(0);
      expect(bi).toBeLessThan(ai); // B first now
    });
  });

  it('rating-mean computes mu into memory_meta', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      // Seed a couple of self ratings: mean of (+1, +1, -1) = 1/3.
      await runQuery(
        `INSERT INTO memory_ratings (injection_id, item_id, rating, source)
         VALUES (gen_random_uuid(), $1, 1, 'self'),
                (gen_random_uuid(), $1, 1, 'self'),
                (gen_random_uuid(), $1, -1, 'self')`,
        [A],
      );
      await runConsolidation({ deep: true, processors: [ratingMeanProcessor] });
      const mu = await getMeta('rating_mean');
      expect(mu).toBeTruthy();
      expect(parseFloat(mu!)).toBeCloseTo(1 / 3, 2);
    });
  });
});
