/**
 * feedback/usefulness.ts -- Pure usefulness math (no I/O, exhaustively unit
 * tested).
 *
 * usefulness() turns a memory's rating history into a scalar in roughly
 * [-1, 1], decayed toward neutral (0) by age so a memory that hasn't been rated
 * lately drifts back to "no opinion" rather than being punished like a panned
 * one. multiplier() maps that to a bounded rank multiplier applied at retrieval.
 *
 *   u = ((sum_self + 0.5·sum_implicit) / (n_self + 0.5·n_implicit) − mu) · e^(−Δt/τ)
 *   m = clamp(1 + 0.3·u, 0.7, 1.3)
 *
 * - Implicit (the `referenced` cross-check) ratings count at half weight.
 * - mu is the global mean rating (positive-skew normalizer); 0 until Phase 6.
 * - τ = 45 days. Δt is measured from last_rated_at.
 * - No ratings → u = 0 → multiplier 1.0 (neutral). The clamp floor (0.7) is the
 *   death-spiral guard: a panned memory is dampened, never erased.
 */

export interface EventStats {
  n_self: number;
  sum_self: number;
  n_implicit: number;
  sum_implicit: number;
  last_rated_at: string | null;
}

export const TAU_MS = 45 * 24 * 60 * 60 * 1000;
const IMPLICIT_WEIGHT = 0.5;
const MULTIPLIER_GAIN = 0.3;
const MULTIPLIER_MIN = 0.7;
const MULTIPLIER_MAX = 1.3;

export function usefulness(stats: EventStats, nowMs: number, mu = 0): number {
  const n = stats.n_self + IMPLICIT_WEIGHT * stats.n_implicit;
  if (n <= 0) return 0;
  const mean = (stats.sum_self + IMPLICIT_WEIGHT * stats.sum_implicit) / n;
  let decay = 1;
  if (stats.last_rated_at) {
    const dt = nowMs - new Date(stats.last_rated_at).getTime();
    decay = Math.exp(-Math.max(0, dt) / TAU_MS);
  }
  return (mean - mu) * decay;
}

export function multiplier(u: number): number {
  return Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, 1 + MULTIPLIER_GAIN * u));
}

/** Convenience: stats → multiplier in one call. */
export function statsMultiplier(stats: EventStats, nowMs: number, mu = 0): number {
  return multiplier(usefulness(stats, nowMs, mu));
}
