/**
 * rating-mean (deep) -- Maintain the global mean rating (mu), the positive-skew
 * normalizer subtracted inside usefulness(). Trailing 90 days, implicit ratings
 * at half weight, written to memory_meta['rating_mean']. Deep-only: it's a
 * slow-moving corpus statistic, not per-turn.
 */

import { runQuery } from '../../timescale-client.js';
import { setMeta } from '../meta.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

export const ratingMeanProcessor: Processor = {
  name: 'rating-mean',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const rows = await runQuery<{ mu: number | null; n: number }>(
      `SELECT
         CASE WHEN COALESCE(sum(w), 0) = 0 THEN NULL
              ELSE sum(rating * w) / sum(w) END AS mu,
         count(*)::int AS n
       FROM (
         SELECT rating, CASE WHEN source = 'implicit' THEN 0.5 ELSE 1.0 END AS w
         FROM memory_ratings
         WHERE ts > NOW() - INTERVAL '90 days'
       ) s`,
    );
    const mu = rows.length > 0 && rows[0].mu !== null ? Number(rows[0].mu) : 0;
    await setMeta('rating_mean', String(mu));
    ctx.log(`rating-mean mu=${mu.toFixed(4)} (n=${rows[0]?.n ?? 0})`);
    return { processed: 1, skipped: 0, exhausted: true };
  },
};
