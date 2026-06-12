/**
 * stats-fold (both) -- Recompute memory_event_stats from memory_ratings.
 *
 * Recompute, never increment (D10): rating volume is tiny and a set-based
 * GROUP BY is idempotent and self-healing, which sidesteps the commit-order
 * races a running counter or a timestamp watermark would have. The tick
 * recomputes only items rated in the last 7 days; the deep pass recomputes the
 * whole table.
 */

import { runQuery } from '../../timescale-client.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

export const statsFoldProcessor: Processor = {
  name: 'stats-fold',
  cadence: 'both',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    // Affected item set: recent on a tick, everything on a deep pass.
    const scope = ctx.deep
      ? ``
      : `WHERE item_id IN (SELECT DISTINCT item_id FROM memory_ratings WHERE ts > NOW() - INTERVAL '7 days')`;

    const rows = await runQuery<{ n: string }>(
      `WITH agg AS (
         SELECT item_id, item_kind,
                count(*) FILTER (WHERE source = 'self')                       AS n_self,
                COALESCE(sum(rating) FILTER (WHERE source = 'self'), 0)       AS sum_self,
                count(*) FILTER (WHERE source = 'implicit')                   AS n_implicit,
                COALESCE(sum(rating) FILTER (WHERE source = 'implicit'), 0)   AS sum_implicit,
                max(ts)                                                       AS last_rated_at
         FROM memory_ratings
         ${scope}
         GROUP BY item_id, item_kind
       )
       INSERT INTO memory_event_stats
         (item_id, item_kind, n_self, sum_self, n_implicit, sum_implicit, last_rated_at, updated_at)
       SELECT item_id, item_kind, n_self, sum_self, n_implicit, sum_implicit, last_rated_at, NOW()
       FROM agg
       ON CONFLICT (item_id) DO UPDATE SET
         item_kind     = EXCLUDED.item_kind,
         n_self        = EXCLUDED.n_self,
         sum_self      = EXCLUDED.sum_self,
         n_implicit    = EXCLUDED.n_implicit,
         sum_implicit  = EXCLUDED.sum_implicit,
         last_rated_at = EXCLUDED.last_rated_at,
         updated_at    = NOW()
       RETURNING 1 AS n`,
    );

    ctx.log(`stats-fold recomputed=${rows.length} scope=${ctx.deep ? 'all' : '7d'}`);
    return { processed: rows.length, skipped: 0, exhausted: true };
  },
};
