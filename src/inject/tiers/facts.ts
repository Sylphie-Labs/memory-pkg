/**
 * facts.ts -- The curated hot tier (schema v4).
 *
 * Trigram match over active memory_facts.search_text, plus an exact-entity
 * match via cluster_key against the query's extracted entities. Facts are few
 * and curated, so this is a cheap point/index lookup — no embedding. Returned
 * candidate event_ids are fact_ids (random UUIDs, no collision with events);
 * generate.ts resolves them from memory_facts and tags event_type='fact'.
 *
 * Fails soft to empty when memory_facts doesn't exist (pre-v4 schema), so a
 * package upgrade ahead of `memory-pkg schema` never breaks injection.
 *
 * Disable via DRIFT_MEMORY_TIER_FACTS_DISABLED=1.
 */

import { runQuery } from '../../timescale-client.js';
import { extractEntities, normalizeEntity } from '../../entities/extract.js';
import type { Tier, TierInput, TierResult } from './types.js';

const TIER_NAME = 'facts';
const MIN_SIMILARITY = 0.2;
const OVERFETCH = 10;

interface Row {
  fact_id: string;
  score: number;
}

export const factsTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();
  if (process.env.DRIFT_MEMORY_TIER_FACTS_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  const entityNorms = [...new Set(extractEntities(input.query || '').map(normalizeEntity))];

  try {
    // Two signals, max-merged: trigram over fact text, and exact cluster_key
    // (entity) match — the latter scored 1.0 so a fact about an entity the
    // prompt names is a top hit.
    const rows = await runQuery<Row>(
      `
      WITH trgm AS (
        SELECT fact_id, word_similarity($1, search_text) AS score
        FROM memory_facts
        WHERE status = 'active' AND $1 <% search_text AND word_similarity($1, search_text) >= $2
      ),
      byent AS (
        SELECT fact_id, 1.0::float8 AS score
        FROM memory_facts
        WHERE status = 'active' AND cluster_key = ANY($3::text[])
      )
      SELECT fact_id, max(score) AS score
      FROM (SELECT * FROM trgm UNION ALL SELECT * FROM byent) u
      GROUP BY fact_id
      ORDER BY score DESC
      LIMIT $4
      `,
      [input.query, MIN_SIMILARITY, entityNorms, OVERFETCH],
    );
    return {
      tier: TIER_NAME,
      candidates: rows.map((r) => ({
        event_id: r.fact_id,
        score: Number(r.score),
        source_tier: TIER_NAME,
      })),
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    // memory_facts absent or query failed — degrade to empty, never throw.
    return { tier: TIER_NAME, candidates: [], latency_ms: Date.now() - t0, disabled: true };
  }
};
