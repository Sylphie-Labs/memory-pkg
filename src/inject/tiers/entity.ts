/**
 * entity.ts -- Per-entity lexical tier.
 *
 * Where trigram.ts matches the literal prompt against every event, this tier
 * extracts salient entities (code identifiers, backticked terms, file paths,
 * quoted phrases) from the current prompt + last ~20 lines of the session
 * transcript, then resolves each entity to matching events. Top K matches per
 * entity are returned as candidates.
 *
 * Resolution has two paths:
 *   - graph (schema v2+, after the entity-link processor has populated
 *     memory_entities): an indexed point lookup — resolve the entity to an
 *     entity_id, then read its linked events straight from memory_entity_events
 *     (denormalized event_type/ts/session), biased toward turn_rationale and
 *     assistant_text. No hypertable scan. This is the structural B1 fix and the
 *     surface the ambient hook stands on.
 *   - legacy (fresh DB before the first deep pass, or pre-v2 schema): the
 *     original per-entity word_similarity scan, now using the GIN-indexable
 *     `<%` operator. Selected automatically when memory_entities is empty.
 *
 * Purpose: when the prompt is a pronoun or short reference ("ok lets do that"),
 * the literal-prompt trigram finds nothing. The entities we're actually
 * talking about live in the recent transcript — so we query for them directly.
 *
 * Metadata surfaced for the orchestrator:
 *   - queried   entities we ran DB queries for (after cap), rank order
 *   - dropped   entities extracted but cut by the cap, rank order
 *   - overflow  { entity: total_matches } when hits > per-entity cap
 *
 * Env toggles:
 *   DRIFT_MEMORY_TIER_ENTITY_DISABLED=1
 *   DRIFT_MEMORY_ENTITY_MAX=N             entity cap (default 8)
 *   DRIFT_MEMORY_ENTITY_PER=N             events per entity (default 2)
 *   DRIFT_MEMORY_TRANSCRIPT_TAIL=N        transcript lines to scan (default 20)
 *   DRIFT_MEMORY_ENTITY_TRANSCRIPT_WEIGHT=0.6
 *     Dampening factor for candidates surfaced by entities that appear only
 *     in the recent transcript (not the current prompt). Default 0.6 means
 *     transcript-only entities still contribute but lose merge-tier ties to
 *     topical retrieval. Set to 1 to disable dampening.
 */

import { readFileSync } from 'node:fs';
import { runQuery } from '../../timescale-client.js';
import { extractEntities, normalizeEntity } from '../../entities/extract.js';
import type { Tier, TierInput, TierResult, Candidate } from './types.js';

const TIER_NAME = 'entity';
const MIN_SIMILARITY = 0.2;
// Fuzzy entity-name resolution floor for the graph path (plan: name_norm ≥ 0.4).
const ENTITY_NAME_MIN_SIMILARITY = 0.4;
// Sentinel entity_id the entity-link processor uses to mark zero-entity events
// as processed; it never matches a real entity at retrieval time.
const NIL_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

// extractEntities + normalizeEntity now live in src/entities/extract.ts
// (shared with the consolidation processor and the ambient hook). Re-export
// extractEntities so existing importers (tests, callers) keep working.
export { extractEntities };

// Pull readable text out of a Claude Code transcript JSONL entry. The
// format is { type, message: { content: string | ContentBlock[] }, ... }
// but we walk defensively so format drift degrades gracefully.
function stringifyContent(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as Record<string, unknown>;
  if (typeof o.content === 'string') return o.content;
  if (Array.isArray(o.content)) {
    return (o.content as unknown[]).map(stringifyContent).join('\n');
  }
  if (o.message !== undefined) return stringifyContent(o.message);
  if (typeof o.text === 'string') return o.text;
  return '';
}

function loadTranscriptTail(path: string, maxLines: number): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines);
  const chunks: string[] = [];
  for (const line of tail) {
    try {
      chunks.push(stringifyContent(JSON.parse(line)));
    } catch {
      chunks.push(line);
    }
  }
  return chunks.join('\n');
}

interface Row {
  event_id: string;
  score: number;
}

interface EntityHit {
  entity: string;
  rows: Row[];
}

/**
 * Has the entity graph been populated yet? One cheap probe per tier invocation
 * (not cached across the process, so it stays correct when tests swap DBs).
 * Any error — including the table not existing on a pre-v2 schema — means "no,
 * use the legacy scan".
 */
async function isEntityGraphPopulated(): Promise<boolean> {
  try {
    const rows = await runQuery<{ has: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM memory_entities LIMIT 1) AS has`,
    );
    return rows.length > 0 && rows[0].has === true;
  } catch {
    return false;
  }
}

/**
 * Graph path: indexed point lookup over memory_entities → memory_entity_events.
 * Resolves the entity by exact name_norm, falling back to fuzzy `<%` over the
 * tiny entities trigram index. Scores fold an event-type bias (turn_rationale >
 * assistant_text > rest) so conclusions outrank mechanics; the result is served
 * entirely from the denormalized link table — no memory_events scan.
 */
async function queryEntityGraph(
  entity: string,
  input: TierInput,
  overfetch: number,
): Promise<EntityHit> {
  const norm = normalizeEntity(entity);
  const params: unknown[] = [norm, ENTITY_NAME_MIN_SIMILARITY, NIL_ENTITY_ID];
  let i = 4;
  let sessionFilter = '';
  if (input.excludeSelf && input.sessionId) {
    sessionFilter = `AND l.session_id <> $${i++}`;
    params.push(input.sessionId);
  }
  params.push(overfetch);
  const limitIdx = i;

  // Two sources, merged by max score per event:
  //   direct -- events whose own text contains the entity (the link rows),
  //             biased turn_rationale > assistant_text > rest.
  //   hop    -- the turn_rationale of any turn a linked event belongs to, even
  //             when the rationale text never names the entity. This is the
  //             associative recall the graph exists for: touch FilterBar in a
  //             grep, surface the turn's "why" without the rationale naming it.
  //             Uses idx_memory_rationale_source (indexed payload hop).
  const sql = `
    WITH ent AS (
      SELECT entity_id, match FROM (
        SELECT entity_id, 1.0::float8 AS match, 0 AS pri
          FROM memory_entities WHERE name_norm = $1
        UNION ALL
        SELECT entity_id, word_similarity($1, name_norm) AS match, 1 AS pri
          FROM memory_entities
          WHERE $1 <% name_norm AND word_similarity($1, name_norm) >= $2
      ) c
      ORDER BY pri ASC, match DESC
      LIMIT 1
    ),
    links AS (
      SELECT l.event_id, l.event_type, l.event_ts, l.turn_user_prompt_id, ent.match
      FROM ent
      JOIN memory_entity_events l ON l.entity_id = ent.entity_id
      WHERE l.entity_id <> $3
        AND l.event_type <> 'tool_result'
        ${sessionFilter}
    ),
    direct AS (
      SELECT event_id,
             (CASE event_type
                WHEN 'turn_rationale' THEN 1.0
                WHEN 'assistant_text' THEN 0.95
                ELSE 0.9
              END) * match AS score
      FROM links
    ),
    hop AS (
      SELECT r.event_id, 0.9 * (SELECT max(match) FROM links) AS score
      FROM memory_events r
      WHERE r.event_type = 'turn_rationale'
        AND r.payload->>'source_user_prompt_id' IN (
          SELECT DISTINCT turn_user_prompt_id::text
          FROM links WHERE turn_user_prompt_id IS NOT NULL
        )
    )
    SELECT event_id, MAX(score) AS score
    FROM (SELECT * FROM direct UNION ALL SELECT * FROM hop) u
    GROUP BY event_id
    ORDER BY score DESC
    LIMIT $${limitIdx}
  `;
  const rows = await runQuery<Row>(sql, params);
  return { entity, rows: rows.map((r) => ({ event_id: r.event_id, score: Number(r.score) })) };
}

/**
 * Legacy path: per-entity word_similarity scan (GIN-indexable via `<%`). Used
 * when the entity graph isn't populated yet.
 */
async function queryEntityLegacy(
  entity: string,
  input: TierInput,
  overfetch: number,
): Promise<EntityHit> {
  const filters: string[] = [
    'search_text IS NOT NULL',
    'excerpt IS NOT NULL',
    `event_type <> 'tool_result'`,
    // GIN-indexable pre-filter (see trigram.ts); recheck below holds the floor.
    '$1 <% search_text',
  ];
  const params: unknown[] = [entity];
  let i = 2;
  if (input.excludeSelf && input.sessionId) {
    filters.push(`session_id <> $${i++}`);
    params.push(input.sessionId);
  }
  params.push(MIN_SIMILARITY);
  const minIdx = i++;
  params.push(overfetch);
  const limitIdx = i;

  const sql = `
    SELECT event_id, word_similarity($1, search_text) AS score
    FROM memory_events
    WHERE ${filters.join(' AND ')}
      AND word_similarity($1, search_text) >= $${minIdx}
    ORDER BY score DESC, ts DESC
    LIMIT $${limitIdx}
  `;
  const rows = await runQuery<Row>(sql, params);
  return { entity, rows };
}

function queryEntity(
  entity: string,
  input: TierInput,
  overfetch: number,
  useGraph: boolean,
): Promise<EntityHit> {
  return useGraph
    ? queryEntityGraph(entity, input, overfetch)
    : queryEntityLegacy(entity, input, overfetch);
}

export const entityTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();
  if (process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  const maxEntities = Math.max(1, parseInt(process.env.DRIFT_MEMORY_ENTITY_MAX || '8', 10));
  const perEntity = Math.max(1, parseInt(process.env.DRIFT_MEMORY_ENTITY_PER || '2', 10));
  const tailLines = Math.max(1, parseInt(process.env.DRIFT_MEMORY_TRANSCRIPT_TAIL || '20', 10));
  // Overfetch so we can detect per-entity overflow without a second query.
  const overfetch = Math.max(perEntity + 1, 10);

  const promptEntities = extractEntities(input.query || '');
  const transcriptEntities = input.transcriptPath
    ? extractEntities(loadTranscriptTail(input.transcriptPath, tailLines))
    : [];

  // Rank entities: current prompt double-weighted, transcript mentions single.
  const scores = new Map<string, number>();
  for (const e of promptEntities) scores.set(e, (scores.get(e) ?? 0) + 2);
  for (const e of transcriptEntities) scores.set(e, (scores.get(e) ?? 0) + 1);

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e);

  const queried = ranked.slice(0, maxEntities);
  const dropped = ranked.slice(maxEntities);

  // Entities not in the current prompt are "transcript-only" — they describe
  // what we were recently touching, not what's being asked about now. Their
  // candidates are dampened so they fall behind topical retrieval at merge time.
  const promptEntitySet = new Set(promptEntities);
  const transcriptWeight = (() => {
    const raw = parseFloat(process.env.DRIFT_MEMORY_ENTITY_TRANSCRIPT_WEIGHT || '0.6');
    if (!Number.isFinite(raw) || raw <= 0) return 0.6;
    return Math.min(raw, 1);
  })();

  if (queried.length === 0) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      metadata: { queried: [], dropped: [], overflow: {} },
    };
  }

  let hits: EntityHit[];
  try {
    const useGraph = await isEntityGraphPopulated();
    hits = await Promise.all(queried.map((e) => queryEntity(e, input, overfetch, useGraph)));
  } catch (err) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      metadata: { queried, dropped, overflow: {} },
    };
  }

  const byId = new Map<string, Candidate>();
  const overflow: Record<string, number> = {};
  for (const hit of hits) {
    if (hit.rows.length > perEntity) overflow[hit.entity] = hit.rows.length;
    const transcriptOnly = !promptEntitySet.has(hit.entity);
    const weight = transcriptOnly ? transcriptWeight : 1;
    for (const row of hit.rows.slice(0, perEntity)) {
      const score = Number(row.score) * weight;
      const existing = byId.get(row.event_id);
      if (!existing || score > existing.score) {
        byId.set(row.event_id, {
          event_id: row.event_id,
          score,
          source_tier: TIER_NAME,
          rationale: transcriptOnly ? `entity:${hit.entity}[transcript]` : `entity:${hit.entity}`,
        });
      }
    }
  }
  const candidates = [...byId.values()].sort((a, b) => b.score - a.score);

  return {
    tier: TIER_NAME,
    candidates,
    latency_ms: Date.now() - t0,
    metadata: { queried, dropped, overflow },
  };
};
