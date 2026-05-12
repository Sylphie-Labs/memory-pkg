/**
 * embedding.ts -- Semantic similarity tier via pgvector cosine KNN.
 *
 * Embeds the query locally (bge-small-en-v1.5) and runs an HNSW-accelerated
 * cosine-distance KNN against the embedding column. Returns candidates scored
 * as `1 - cosine_distance` so higher = more similar.
 *
 * Disable via DRIFT_MEMORY_TIER_EMBEDDING_DISABLED=1. Fails closed on any
 * error (missing extension, model load failure, DB issue) — other tiers still
 * serve their candidates.
 */

import { runQuery } from '../../timescale-client.js';
import { embed, toVectorLiteral } from '../../embed.js';
import type { Tier, TierInput, TierResult } from './types.js';

const TIER_NAME = 'embedding';
const TOP_K = 20;
const MIN_SIMILARITY = 0.3;

interface Row {
  event_id: string;
  score: number;
}

export const embeddingTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();

  if (process.env.DRIFT_MEMORY_TIER_EMBEDDING_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  try {
    const vec = await embed(input.query);
    const literal = toVectorLiteral(vec);

    const filters: string[] = [
      'embedding IS NOT NULL',
      `event_type <> 'tool_result'`,
    ];
    const params: unknown[] = [literal];
    let i = 2;

    if (input.excludeSelf && input.sessionId) {
      filters.push(`session_id <> $${i++}`);
      params.push(input.sessionId);
    }

    // pgvector <=> returns cosine distance (0 = identical, 2 = opposite).
    // Similarity = 1 - distance. HNSW index is used when ORDER BY <=> is present.
    const sql = `
      SELECT
        event_id,
        1 - (embedding <=> $1::vector) AS score
      FROM memory_events
      WHERE ${filters.join(' AND ')}
      ORDER BY embedding <=> $1::vector
      LIMIT ${TOP_K}
    `;

    const rows = await runQuery<Row>(sql, params);
    const candidates = rows
      .map((r) => ({ event_id: r.event_id, score: Number(r.score), source_tier: TIER_NAME }))
      .filter((c) => c.score >= MIN_SIMILARITY);

    return { tier: TIER_NAME, candidates, latency_ms: Date.now() - t0 };
  } catch (err) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
