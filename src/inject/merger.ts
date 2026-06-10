/**
 * merger.ts -- Combine candidate sets from multiple tiers into one ranked list.
 *
 * Three strategies:
 *   union         max score per event across tiers (no weights)
 *   weighted      weighted average across contributing tiers (default)
 *   intersection  weighted average, but filter to events surfaced by >= minAgreement tiers
 *
 * All strategies output `MergedCandidate` with `source_tiers` preserved for
 * attribution in the formatted output (e.g. "Match 1 — [trigram+embedding]").
 *
 * Config is read from env at call-time by loadMergerConfig. Direct callers can
 * pass an explicit config to override for testing.
 */

import type { Candidate, TierResult } from './tiers/types.js';

export type MergeStrategy = 'union' | 'weighted' | 'intersection';

export interface MergerConfig {
  strategy: MergeStrategy;
  weights: Record<string, number>;
  minAgreement: number;
  maxResults: number;
  diversityPerType: number;
}

export interface MergedCandidate extends Candidate {
  source_tiers: string[];
  per_tier_scores: Record<string, number>;
  event_type?: string;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  trigram: 0.2,
  entity: 0.3,
  embedding: 0.3,
};

export function loadMergerConfig(): MergerConfig {
  const rawStrategy = (process.env.DRIFT_MEMORY_MERGE_STRATEGY || 'weighted') as MergeStrategy;
  const strategy: MergeStrategy =
    rawStrategy === 'union' || rawStrategy === 'intersection' ? rawStrategy : 'weighted';

  let weights = DEFAULT_WEIGHTS;
  if (process.env.DRIFT_MEMORY_TIER_WEIGHTS) {
    try {
      const parsed = JSON.parse(process.env.DRIFT_MEMORY_TIER_WEIGHTS);
      if (parsed && typeof parsed === 'object') {
        weights = parsed as Record<string, number>;
      }
    } catch {
      // fall back to defaults on parse error
    }
  }

  return {
    strategy,
    weights,
    minAgreement: Math.max(1, parseInt(process.env.DRIFT_MEMORY_MIN_AGREEMENT || '2', 10)),
    maxResults: Math.max(1, parseInt(process.env.DRIFT_MEMORY_MERGE_MAX_RESULTS || '30', 10)),
    diversityPerType: Math.max(0, parseInt(process.env.DRIFT_MEMORY_DIVERSITY_PER_TYPE || '0', 10)),
  };
}

interface Accumulator {
  event_id: string;
  per_tier_scores: Record<string, number>;
}

function groupByEventId(results: TierResult[]): Map<string, Accumulator> {
  const byId = new Map<string, Accumulator>();
  for (const result of results) {
    if (result.disabled || result.error) continue;
    for (const c of result.candidates) {
      let acc = byId.get(c.event_id);
      if (!acc) {
        acc = { event_id: c.event_id, per_tier_scores: {} };
        byId.set(c.event_id, acc);
      }
      // If a tier returned the same event twice, keep the higher score.
      const existing = acc.per_tier_scores[c.source_tier];
      if (existing === undefined || c.score > existing) {
        acc.per_tier_scores[c.source_tier] = c.score;
      }
    }
  }
  return byId;
}

function scoreCandidate(
  acc: Accumulator,
  strategy: MergeStrategy,
  weights: Record<string, number>,
): number {
  const tiers = Object.keys(acc.per_tier_scores);

  if (strategy === 'union') {
    return Math.max(...tiers.map((t) => acc.per_tier_scores[t]));
  }

  // weighted / intersection both use weighted average over contributing tiers.
  let num = 0;
  let den = 0;
  for (const t of tiers) {
    const w = weights[t] ?? 0;
    if (w <= 0) continue;
    num += w * acc.per_tier_scores[t];
    den += w;
  }
  if (den === 0) {
    // No weights matched → fall back to simple average across tiers.
    const sum = tiers.reduce((s, t) => s + acc.per_tier_scores[t], 0);
    return sum / tiers.length;
  }
  return num / den;
}

export function mergeCandidates(
  results: TierResult[],
  config: MergerConfig = loadMergerConfig(),
): MergedCandidate[] {
  const grouped = groupByEventId(results);

  const scored: MergedCandidate[] = [];
  for (const acc of grouped.values()) {
    const tiers = Object.keys(acc.per_tier_scores).sort();
    if (config.strategy === 'intersection' && tiers.length < config.minAgreement) continue;
    const score = scoreCandidate(acc, config.strategy, config.weights);
    if (!Number.isFinite(score) || score <= 0) continue;
    scored.push({
      event_id: acc.event_id,
      score,
      source_tier: tiers.join('+'),
      source_tiers: tiers,
      per_tier_scores: acc.per_tier_scores,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, config.maxResults);
}

/**
 * Apply per-type diversity cap AFTER the orchestrator has attached event_type
 * to each merged candidate. Walks in score DESC order and skips candidates
 * whose type is already at the cap. `limit === 0` disables the cap.
 */
export function applyDiversity<T extends { event_type?: string }>(
  ranked: T[],
  limit: number,
): T[] {
  if (limit <= 0) return ranked;
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const c of ranked) {
    const key = c.event_type ?? '_unknown';
    const n = counts.get(key) ?? 0;
    if (n >= limit) continue;
    counts.set(key, n + 1);
    out.push(c);
  }
  return out;
}
