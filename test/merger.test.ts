import { describe, it, expect } from 'vitest';
import { mergeCandidates, applyDiversity, type MergerConfig } from '../src/inject/merger.js';
import type { Candidate, TierResult } from '../src/inject/tiers/types.js';

/** Build a TierResult quickly. `tier` is the producing tier; each candidate
 *  carries its own `source_tier` (that is what the merger groups on). */
function tierResult(tier: string, candidates: Array<Partial<Candidate> & { event_id: string; score: number }>): TierResult {
  return {
    tier,
    latency_ms: 0,
    candidates: candidates.map((c) => ({
      event_id: c.event_id,
      score: c.score,
      source_tier: c.source_tier ?? tier,
    })),
  };
}

function config(overrides: Partial<MergerConfig> = {}): MergerConfig {
  return {
    strategy: 'weighted',
    weights: { trigram: 0.2, entity: 0.3, embedding: 0.3 },
    minAgreement: 2,
    maxResults: 30,
    diversityPerType: 0,
    ...overrides,
  };
}

describe('mergeCandidates weighted strategy', () => {
  it('uses weights to combine known-tier scores (weighted average)', () => {
    // event E1: trigram=0.5 (w=0.2), embedding=1.0 (w=0.3)
    // expected = (0.2*0.5 + 0.3*1.0) / (0.2+0.3) = (0.1+0.3)/0.5 = 0.8
    const results = [
      tierResult('trigram', [{ event_id: 'E1', score: 0.5 }]),
      tierResult('embedding', [{ event_id: 'E1', score: 1.0 }]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'weighted' }));
    expect(merged).toHaveLength(1);
    expect(merged[0].event_id).toBe('E1');
    expect(merged[0].score).toBeCloseTo(0.8, 10);
    expect(merged[0].source_tiers).toEqual(['embedding', 'trigram']);
    expect(merged[0].per_tier_scores).toEqual({ trigram: 0.5, embedding: 1.0 });
  });

  it('falls back to simple average when no tier weight matches', () => {
    // Unknown tiers => den===0 => simple average of (0.4, 0.8) = 0.6
    const results = [
      tierResult('mystery', [{ event_id: 'E1', score: 0.4 }]),
      tierResult('unknown', [{ event_id: 'E1', score: 0.8 }]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'weighted' }));
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBeCloseTo(0.6, 10);
  });
});

describe('mergeCandidates intersection strategy (minAgreement)', () => {
  it('drops a candidate appearing in only 1 tier and keeps one in 2 tiers', () => {
    const results = [
      tierResult('trigram', [
        { event_id: 'BOTH', score: 0.5 },
        { event_id: 'SOLO', score: 0.9 },
      ]),
      tierResult('embedding', [{ event_id: 'BOTH', score: 0.5 }]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'intersection', minAgreement: 2 }));
    const ids = merged.map((m) => m.event_id);
    expect(ids).toContain('BOTH');
    expect(ids).not.toContain('SOLO');
    expect(merged).toHaveLength(1);
  });

  it('weighted strategy does NOT apply minAgreement (single-tier candidates kept)', () => {
    const results = [
      tierResult('trigram', [{ event_id: 'SOLO', score: 0.9 }]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'weighted', minAgreement: 2 }));
    expect(merged.map((m) => m.event_id)).toEqual(['SOLO']);
  });
});

describe('mergeCandidates score filtering', () => {
  it('drops score-0 candidates from output', () => {
    const results = [
      tierResult('trigram', [
        { event_id: 'KEEP', score: 0.5 },
        { event_id: 'ZERO', score: 0 },
      ]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'weighted' }));
    expect(merged.map((m) => m.event_id)).toEqual(['KEEP']);
  });
});

describe('mergeCandidates maxResults cap', () => {
  it('returns only the top N by score when candidates exceed the cap', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      event_id: `E${i}`,
      score: (i + 1) / 10, // 0.1 .. 1.0
    }));
    const results = [tierResult('trigram', candidates)];
    const merged = mergeCandidates(results, config({ strategy: 'weighted', maxResults: 3 }));
    expect(merged).toHaveLength(3);
    // Sorted score DESC: E9 (1.0), E8 (0.9), E7 (0.8)
    expect(merged.map((m) => m.event_id)).toEqual(['E9', 'E8', 'E7']);
  });
});

describe('mergeCandidates union strategy', () => {
  it('takes the max score per event across tiers', () => {
    const results = [
      tierResult('trigram', [{ event_id: 'E1', score: 0.3 }]),
      tierResult('embedding', [{ event_id: 'E1', score: 0.9 }]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'union' }));
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBeCloseTo(0.9, 10);
  });
});

describe('mergeCandidates edge cases', () => {
  it('empty input → empty output', () => {
    expect(mergeCandidates([], config())).toEqual([]);
    expect(mergeCandidates([tierResult('trigram', [])], config())).toEqual([]);
  });

  it('single tier → passthrough scores (weighted over one tier == that score)', () => {
    const results = [
      tierResult('trigram', [
        { event_id: 'A', score: 0.7 },
        { event_id: 'B', score: 0.4 },
      ]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'weighted' }));
    expect(merged.map((m) => m.event_id)).toEqual(['A', 'B']);
    expect(merged[0].score).toBeCloseTo(0.7, 10);
    expect(merged[1].score).toBeCloseTo(0.4, 10);
  });

  it('skips disabled and errored tier results', () => {
    const results: TierResult[] = [
      { tier: 'trigram', latency_ms: 0, disabled: true, candidates: [{ event_id: 'X', score: 0.9, source_tier: 'trigram' }] },
      { tier: 'entity', latency_ms: 0, error: 'boom', candidates: [{ event_id: 'Y', score: 0.9, source_tier: 'entity' }] },
      tierResult('embedding', [{ event_id: 'Z', score: 0.6 }]),
    ];
    const merged = mergeCandidates(results, config({ strategy: 'weighted' }));
    expect(merged.map((m) => m.event_id)).toEqual(['Z']);
  });
});

describe('applyDiversity (per event_type cap)', () => {
  it('caps the number of results per event_type', () => {
    const ranked = [
      { event_id: '1', event_type: 'tool_call' },
      { event_id: '2', event_type: 'tool_call' },
      { event_id: '3', event_type: 'tool_call' },
      { event_id: '4', event_type: 'user_prompt' },
    ];
    const out = applyDiversity(ranked, 2);
    expect(out.map((r) => r.event_id)).toEqual(['1', '2', '4']);
  });

  it('limit <= 0 disables the cap (passthrough)', () => {
    const ranked = [
      { event_id: '1', event_type: 'tool_call' },
      { event_id: '2', event_type: 'tool_call' },
    ];
    expect(applyDiversity(ranked, 0)).toBe(ranked);
  });

  it('treats missing event_type as a single _unknown bucket', () => {
    const ranked = [{ event_id: '1' }, { event_id: '2' }, { event_id: '3' }];
    const out = applyDiversity(ranked, 2);
    expect(out.map((r) => r.event_id)).toEqual(['1', '2']);
  });
});
