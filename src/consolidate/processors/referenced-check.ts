/**
 * referenced-check (tick) -- The near-free implicit cross-check (F4).
 *
 * For each injection in the current session that has no implicit rating yet,
 * decide — per injected item — whether the session actually *used* it after it
 * was injected: did a later tool_call touch the item's file, or did a later
 * assistant_text mention one of the item's entities? Records an append-only
 * `source='implicit'` rating (rating = referenced ? 1 : 0, plus the boolean).
 *
 * This is an independent signal from self-rating. A self +1 with referenced=0
 * is suspect; if self-rating proves noisy, this becomes the fallback driver —
 * which is why it's kept strictly separate in the data.
 *
 * Runs after ingest-flush + entity-link so the current turn's events and their
 * entity links are already in the DB.
 */

import { runQuery } from '../../timescale-client.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

interface InjectionRow {
  injection_id: string;
  ts: string;
  item_ids: string[];
}

export const referencedCheckProcessor: Processor = {
  name: 'referenced-check',
  cadence: 'tick',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    if (!ctx.sessionId) return { processed: 0, skipped: 0, exhausted: true };
    const session = ctx.sessionId;

    const injections = await runQuery<InjectionRow>(
      `SELECT injection_id, ts, item_ids
       FROM memory_injections i
       WHERE session_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM memory_ratings r
           WHERE r.injection_id = i.injection_id AND r.source = 'implicit'
         )
       ORDER BY ts ASC`,
      [session],
    );

    let processed = 0;
    for (const inj of injections) {
      if (Date.now() >= ctx.deadline) return { processed, skipped: 0, exhausted: false };

      // Window end: the next user_prompt in this session after the injection.
      const next = await runQuery<{ ts: string }>(
        `SELECT ts FROM memory_events
         WHERE session_id = $1 AND event_type = 'user_prompt' AND ts > $2::timestamptz
         ORDER BY ts ASC LIMIT 1`,
        [session, inj.ts],
      );
      const windowEnd = next.length > 0 ? next[0].ts : null;
      const windowClause = windowEnd ? `AND ts < $3::timestamptz` : '';
      const windowParams = (extra: unknown[]) =>
        windowEnd ? [session, inj.ts, windowEnd, ...extra] : [session, inj.ts, ...extra];
      const extraIdx = windowEnd ? 4 : 3;

      for (const itemId of inj.item_ids) {
        // The injected memory's file + linked entity names (cross-session).
        const meta = await runQuery<{ file_path: string | null }>(
          `SELECT file_path FROM memory_events WHERE event_id = $1::uuid LIMIT 1`,
          [itemId],
        );
        const filePath = meta.length > 0 ? meta[0].file_path : null;
        const ents = await runQuery<{ name_norm: string }>(
          `SELECT e.name_norm
           FROM memory_entity_events l JOIN memory_entities e ON e.entity_id = l.entity_id
           WHERE l.event_id = $1::uuid AND e.name_norm <> ''`,
          [itemId],
        );
        const entNames = ents.map((r) => r.name_norm).filter((n) => n.length >= 3);

        // (a) a later tool_call touched the same file.
        let referenced = false;
        if (filePath) {
          const hit = await runQuery<{ n: number }>(
            `SELECT count(*)::int AS n FROM memory_events
             WHERE session_id = $1 AND event_type = 'tool_call' AND file_path = $${extraIdx}
               AND ts >= $2::timestamptz ${windowClause}`,
            windowParams([filePath]),
          );
          if (hit[0].n > 0) referenced = true;
        }

        // (b) a later assistant_text mentioned one of the item's entities.
        if (!referenced && entNames.length > 0) {
          const patterns = entNames.map((n) => `%${n}%`);
          const hit = await runQuery<{ n: number }>(
            `SELECT count(*)::int AS n FROM memory_events
             WHERE session_id = $1 AND event_type = 'assistant_text'
               AND ts >= $2::timestamptz ${windowClause}
               AND lower(search_text) ILIKE ANY($${extraIdx}::text[])`,
            windowParams([patterns]),
          );
          if (hit[0].n > 0) referenced = true;
        }

        await runQuery(
          `INSERT INTO memory_ratings (injection_id, item_id, item_kind, rating, source, referenced, session_id)
           VALUES ($1, $2, 'event', $3, 'implicit', $4, $5)
           ON CONFLICT (injection_id, item_id, source) DO NOTHING`,
          [inj.injection_id, itemId, referenced ? 1 : 0, referenced, session],
        );
      }
      processed++;
    }

    ctx.log(`referenced-check processed=${processed} injections`);
    return { processed, skipped: 0, exhausted: true };
  },
};
