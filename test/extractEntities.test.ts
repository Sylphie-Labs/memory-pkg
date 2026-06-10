import { describe, it, expect } from 'vitest';
import { extractEntities } from '../src/inject/tiers/entity.js';

describe('extractEntities', () => {
  it('pulls backticked identifiers', () => {
    expect(extractEntities('please update `getModelFor` today')).toContain('getModelFor');
  });

  it('pulls file-path-shaped tokens', () => {
    expect(extractEntities('see src/inject/generate.ts for details')).toContain(
      'src/inject/generate.ts',
    );
  });

  it('pulls CamelCase and snake_case identifiers', () => {
    const out = extractEntities('the MemoryEvents table and turn_rationale rows');
    expect(out).toContain('MemoryEvents');
    expect(out).toContain('turn_rationale');
  });

  it('drops schema/stopword tokens even when shaped like identifiers', () => {
    // assistant_text matches the snake_case shape but is a known stopword.
    expect(extractEntities('the assistant_text column')).not.toContain('assistant_text');
  });

  it('returns [] for prose with no identifiers', () => {
    expect(extractEntities('lets do that now please')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(extractEntities('')).toEqual([]);
  });
});
