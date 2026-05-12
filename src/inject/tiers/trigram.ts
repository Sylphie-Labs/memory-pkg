/**
 * trigram.ts -- Lexical tier using Postgres pg_trgm word_similarity.
 *
 * Lifted from the pre-refactor generate.ts SQL. Returns candidates scored
 * by word_similarity against search_text. Strong-vs-ambiguous split and
 * rerank are NOT done here — they happen in the orchestrator after the
 * merger, because rerank operates on the combined candidate set.
 *
 * Disable via DRIFT_MEMORY_TIER_TRIGRAM_DISABLED=1.
 */

import { runQuery } from '../../timescale-client.js';
import type { Tier, TierInput, TierResult } from './types.js';

const TIER_NAME = 'trigram';
const MIN_SIMILARITY = 0.2;
const OVERFETCH = 20;

interface Row {
  event_id: string;
  score: number;
}

export const trigramTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();

  if (process.env.DRIFT_MEMORY_TIER_TRIGRAM_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  const filters: string[] = [
    'search_text IS NOT NULL',
    'excerpt IS NOT NULL',
    `event_type <> 'tool_result'`,
  ];
  const params: unknown[] = [input.query];
  let i = 2;

  if (input.excludeSelf && input.sessionId) {
    filters.push(`session_id <> $${i++}`);
    params.push(input.sessionId);
  }

  params.push(MIN_SIMILARITY);
  const minIdx = i++;
  params.push(OVERFETCH);
  const limitIdx = i;

  // word_similarity finds the query's best-matching extent inside the document
  // — right metric for short user prompts against longer event records.
  const sql = `
    SELECT
      event_id,
      word_similarity($1, search_text) AS score
    FROM memory_events
    WHERE ${filters.join(' AND ')}
      AND word_similarity($1, search_text) >= $${minIdx}
    ORDER BY score DESC, ts DESC
    LIMIT $${limitIdx}
  `;

  try {
    const rows = await runQuery<Row>(sql, params);
    return {
      tier: TIER_NAME,
      candidates: rows.map((r) => ({
        event_id: r.event_id,
        score: Number(r.score),
        source_tier: TIER_NAME,
      })),
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
