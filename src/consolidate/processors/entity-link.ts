/**
 * entity-link (both) -- Populate the bipartite entity graph from event text,
 * deterministically (extractEntities — no LLM).
 *
 * Anti-join queue: events with no row in memory_entity_events. Each event's
 * text is scanned for entities; for each, memory_entities is upserted and a
 * link row inserted (carrying denormalized event_type/ts/session + the turn
 * anchor — the latest user_prompt at/<before the event). Events with zero
 * entities get a single sentinel link (NIL entity_id) so they leave the queue.
 *
 * Tick scope: the current session (cheap, just the turn's new events). Deep
 * scope: the whole corpus, budgeted and resumable — the first deep pass after
 * upgrade backfills history across however many runs it takes.
 */

import { runQuery } from '../../timescale-client.js';
import { extractEntities, normalizeEntity } from '../../entities/extract.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const NIL_ENTITY_ID = '00000000-0000-0000-0000-000000000000';
const BATCH = 200;

interface EventRow {
  event_id: string;
  ts: string;
  event_type: string;
  session_id: string;
  search_text: string | null;
  excerpt: string | null;
}

async function nextBatch(sessionId: string | undefined): Promise<EventRow[]> {
  const params: unknown[] = [];
  let sessionFilter = '';
  if (sessionId) {
    sessionFilter = `AND e.session_id = $1`;
    params.push(sessionId);
  }
  params.push(BATCH);
  const limitIdx = params.length;
  return runQuery<EventRow>(
    `SELECT e.event_id, e.ts, e.event_type, e.session_id, e.search_text, e.excerpt
     FROM memory_events e
     WHERE e.event_type <> 'tool_result'
       AND (e.search_text IS NOT NULL OR e.excerpt IS NOT NULL)
       ${sessionFilter}
       AND NOT EXISTS (
         SELECT 1 FROM memory_entity_events l WHERE l.event_id = e.event_id
       )
     ORDER BY e.ts DESC
     LIMIT $${limitIdx}`,
    params,
  );
}

async function turnAnchor(sessionId: string, ts: string): Promise<string | null> {
  const rows = await runQuery<{ event_id: string }>(
    `SELECT event_id FROM memory_events
     WHERE session_id = $1 AND event_type = 'user_prompt' AND ts <= $2::timestamptz
     ORDER BY ts DESC LIMIT 1`,
    [sessionId, ts],
  );
  return rows.length > 0 ? rows[0].event_id : null;
}

async function upsertEntity(raw: string): Promise<string> {
  const norm = normalizeEntity(raw);
  const rows = await runQuery<{ entity_id: string }>(
    `INSERT INTO memory_entities (name_norm, display_name, first_seen, last_seen, event_count)
     VALUES ($1, $2, NOW(), NOW(), 1)
     ON CONFLICT (name_norm)
       DO UPDATE SET last_seen = NOW(), event_count = memory_entities.event_count + 1
     RETURNING entity_id`,
    [norm, raw],
  );
  return rows[0].entity_id;
}

async function insertLink(
  entityId: string,
  ev: EventRow,
  turnId: string | null,
): Promise<void> {
  await runQuery(
    `INSERT INTO memory_entity_events
       (entity_id, event_id, event_ts, event_type, session_id, turn_user_prompt_id)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6)
     ON CONFLICT (entity_id, event_id) DO NOTHING`,
    [entityId, ev.event_id, ev.ts, ev.event_type, ev.session_id, turnId],
  );
}

export const entityLinkProcessor: Processor = {
  name: 'entity-link',
  cadence: 'both',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    let processed = 0;
    let skipped = 0;
    let exhausted = true;

    outer: while (Date.now() < ctx.deadline) {
      let batch: EventRow[];
      try {
        batch = await nextBatch(ctx.sessionId);
      } catch (err) {
        ctx.log(`entity-link query failed: ${err instanceof Error ? err.message : String(err)}`);
        return { processed, skipped, exhausted: false };
      }
      if (batch.length === 0) break;

      for (const ev of batch) {
        // Only break between events, never mid-event, so an event is always
        // fully linked once started (a half-linked event would leave the queue
        // with missing entities).
        if (Date.now() >= ctx.deadline) {
          exhausted = false;
          break outer;
        }

        // Extract from the excerpt (clean, human-readable summary) rather than
        // search_text: search_text is prefixed with the event_type and, for
        // tool_call events, embeds the raw input JSON — whose keys ("file_path",
        // "command", "replace_all", …) flood the graph with structural noise
        // via the double-quote rule. The excerpt is the curated content.
        const text = ev.excerpt ?? ev.search_text ?? '';
        const entities = extractEntities(text);

        try {
          if (entities.length === 0) {
            await insertLink(NIL_ENTITY_ID, ev, null); // sentinel: leaves the queue
            skipped++;
            continue;
          }
          const turnId = await turnAnchor(ev.session_id, ev.ts);
          for (const raw of entities) {
            const entityId = await upsertEntity(raw);
            await insertLink(entityId, ev, turnId);
          }
          processed++;
        } catch (err) {
          ctx.log(`entity-link error on ${ev.event_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    ctx.log(`entity-link processed=${processed} skipped=${skipped} exhausted=${exhausted}`);
    return { processed, skipped, exhausted };
  },
};
