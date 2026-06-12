/**
 * usefulness.test.ts -- The pure feedback math (Phase 4).
 */

import { describe, it, expect } from 'vitest';
import { usefulness, multiplier, statsMultiplier, TAU_MS, type EventStats } from '../src/feedback/usefulness.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const recent = new Date(NOW).toISOString();
const empty: EventStats = { n_self: 0, sum_self: 0, n_implicit: 0, sum_implicit: 0, last_rated_at: null };

describe('usefulness', () => {
  it('no ratings → 0 (neutral)', () => {
    expect(usefulness(empty, NOW)).toBe(0);
    expect(multiplier(usefulness(empty, NOW))).toBe(1);
  });

  it('all +1 self, just rated → u≈1', () => {
    const s: EventStats = { n_self: 3, sum_self: 3, n_implicit: 0, sum_implicit: 0, last_rated_at: recent };
    expect(usefulness(s, NOW)).toBeCloseTo(1, 5);
    expect(multiplier(usefulness(s, NOW))).toBeCloseTo(1.3, 5); // clamped at max
  });

  it('all -1 self → multiplier clamped at floor 0.7, never lower', () => {
    const s: EventStats = { n_self: 4, sum_self: -4, n_implicit: 0, sum_implicit: 0, last_rated_at: recent };
    expect(usefulness(s, NOW)).toBeCloseTo(-1, 5);
    expect(multiplier(usefulness(s, NOW))).toBeCloseTo(0.7, 5);
  });

  it('decays toward neutral with age (τ = 45d)', () => {
    const oneTauAgo = new Date(NOW - TAU_MS).toISOString();
    const s: EventStats = { n_self: 1, sum_self: 1, n_implicit: 0, sum_implicit: 0, last_rated_at: oneTauAgo };
    // u = 1 * e^-1 ≈ 0.3679
    expect(usefulness(s, NOW)).toBeCloseTo(Math.exp(-1), 4);
  });

  it('subtracts mu (positive-skew normalizer)', () => {
    const s: EventStats = { n_self: 2, sum_self: 2, n_implicit: 0, sum_implicit: 0, last_rated_at: recent };
    // mean 1, mu 0.5 → u = 0.5
    expect(usefulness(s, NOW, 0.5)).toBeCloseTo(0.5, 5);
    expect(statsMultiplier(s, NOW, 0.5)).toBeCloseTo(1.15, 5);
  });

  it('weights implicit ratings at half', () => {
    // Only implicit ratings: n = 0.5*2 = 1, mean = (0.5*2)/1 = 1.
    const s: EventStats = { n_self: 0, sum_self: 0, n_implicit: 2, sum_implicit: 2, last_rated_at: recent };
    expect(usefulness(s, NOW)).toBeCloseTo(1, 5);
    // A self +1 plus an implicit +1: n = 1 + 0.5 = 1.5, mean = (1 + 0.5)/1.5 = 1.
    const mixed: EventStats = { n_self: 1, sum_self: 1, n_implicit: 1, sum_implicit: 1, last_rated_at: recent };
    expect(usefulness(mixed, NOW)).toBeCloseTo(1, 5);
  });

  it('multiplier is always within [0.7, 1.3]', () => {
    for (const u of [-5, -1, -0.3, 0, 0.3, 1, 5]) {
      const m = multiplier(u);
      expect(m).toBeGreaterThanOrEqual(0.7);
      expect(m).toBeLessThanOrEqual(1.3);
    }
  });
});
