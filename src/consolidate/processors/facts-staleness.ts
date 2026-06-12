/**
 * facts-staleness (deep) -- Retire facts that no longer earn their place.
 *
 * A fact is retired (status='retired', never injected again) when either:
 *   - its cluster's current blended mean rating has fallen below +0.2
 *     (the work it distilled is no longer rated useful), or
 *   - the fact's OWN ratings (item_kind='fact', flowing through the normal
 *     rating pipeline) have gone net-negative.
 *
 * Supersession (re-promotion) is handled by facts-promote; this only retires.
 */

import { runQuery } from '../../timescale-client.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const RETIRE_BELOW_MEAN = 0.2;

export const factsStalenessProcessor: Processor = {
  name: 'facts-staleness',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    let retired = 0;
    try {
      // (a) cluster mean fell below the retire floor.
      const byCluster = await runQuery<{ fact_id: string }>(
        `UPDATE memory_facts f SET status = 'retired'
         WHERE f.status = 'active'
           AND COALESCE((
             SELECT sum(s.sum_self + 0.5 * s.sum_implicit)
                    / NULLIF(sum(s.n_self + 0.5 * s.n_implicit), 0)
             FROM memory_entity_events l
             JOIN memory_entities e ON e.entity_id = l.entity_id
             JOIN memory_event_stats s ON s.item_id = l.event_id
             WHERE e.name_norm = f.cluster_key
           ), 0) < ${RETIRE_BELOW_MEAN}
         RETURNING fact_id`,
      );
      retired += byCluster.length;

      // (b) the fact's own ratings went net-negative.
      const byOwn = await runQuery<{ fact_id: string }>(
        `UPDATE memory_facts f SET status = 'retired'
         WHERE f.status = 'active'
           AND EXISTS (
             SELECT 1 FROM memory_event_stats s
             WHERE s.item_id = f.fact_id
               AND (s.sum_self + 0.5 * s.sum_implicit) < 0
           )
         RETURNING fact_id`,
      );
      retired += byOwn.length;
    } catch (err) {
      ctx.log(`facts-staleness failed: ${err instanceof Error ? err.message : String(err)}`);
      return { processed: retired, skipped: 0, exhausted: false };
    }

    ctx.log(`facts-staleness retired=${retired}`);
    return { processed: retired, skipped: 0, exhausted: true };
  },
};
