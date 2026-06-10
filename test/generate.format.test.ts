import { describe, it, expect } from 'vitest';
import { formatInjectBlock, type RankedRow } from '../src/inject/generate.js';

function makeRow(over: Partial<RankedRow> = {}): RankedRow {
  return {
    event_id: 'e1',
    ts: '2026-01-01T12:00:00.000Z',
    session_id: 'S1',
    event_type: 'assistant_text',
    tool_name: null,
    summary: null,
    excerpt: 'a memorable excerpt about widgets',
    file_path: null,
    merged_score: 0.82,
    tier: 'trigram',
    ...over,
  };
}

describe('formatInjectBlock', () => {
  it('empty ranked list returns empty string', () => {
    expect(formatInjectBlock([]).text).toBe('');
  });

  it('single row with excerpt returns a block containing tags and the excerpt', () => {
    const { text: out } = formatInjectBlock([makeRow({ excerpt: 'unique-needle-text' })]);
    expect(out).toContain('<memory-context>');
    expect(out).toContain('</memory-context>');
    expect(out).toContain('unique-needle-text');
  });

  it('tool_result rows are skipped (returns empty when only tool_result present)', () => {
    const { text: out } = formatInjectBlock([makeRow({ event_type: 'tool_result' })]);
    expect(out).toBe('');
  });

  it('rows with null excerpt and null summary are skipped', () => {
    const { text: out } = formatInjectBlock([makeRow({ excerpt: null, summary: null })]);
    expect(out).toBe('');
  });

  it('falls back to summary when excerpt is null', () => {
    const { text: out } = formatInjectBlock([
      makeRow({ excerpt: null, summary: 'summary-fallback-text' }),
    ]);
    expect(out).toContain('summary-fallback-text');
  });

  it('char budget: a single 5000-char excerpt is dropped when it exceeds the budget', () => {
    const { text: out } = formatInjectBlock([makeRow({ excerpt: 'x'.repeat(5000) })], {
      maxChars: 4000,
    });
    // The oversized block cannot fit; result is empty (no partial truncation).
    expect(out).toBe('');
  });

  it('first row fills the budget so a second row is absent', () => {
    const big = 'A'.repeat(900);
    const second = 'SECOND-ROW-MARKER';
    const { text: out } = formatInjectBlock(
      [
        makeRow({ event_id: 'big', excerpt: big }),
        makeRow({ event_id: 'small', excerpt: second }),
      ],
      { maxChars: 1000 },
    );
    expect(out).toContain('AAA');
    expect(out).not.toContain(second);
  });

  it('limit=1 with 3 rows yields only one match block', () => {
    const { text: out } = formatInjectBlock(
      [
        makeRow({ event_id: 'r1', excerpt: 'first-match-marker' }),
        makeRow({ event_id: 'r2', excerpt: 'second-match-marker' }),
        makeRow({ event_id: 'r3', excerpt: 'third-match-marker' }),
      ],
      { limit: 1 },
    );
    expect(out).toContain('first-match-marker');
    expect(out).not.toContain('second-match-marker');
    expect(out).not.toContain('third-match-marker');
    // Exactly one "### Match" heading.
    expect((out.match(/### Match/g) ?? []).length).toBe(1);
  });

  it('no rows fit after the budget returns empty string', () => {
    const { text: out } = formatInjectBlock([makeRow({ excerpt: 'z'.repeat(500) })], {
      maxChars: 10,
    });
    expect(out).toBe('');
  });

  it('included array mirrors only rendered rows', () => {
    const rows = [
      makeRow({ event_id: 'r1', excerpt: 'alpha' }),
      makeRow({ event_id: 'r2', event_type: 'tool_result', excerpt: 'beta' }),
      makeRow({ event_id: 'r3', excerpt: 'gamma' }),
    ];
    const { included } = formatInjectBlock(rows);
    expect(included.map((r) => r.event_id)).toEqual(['r1', 'r3']);
  });
});
