import { describe, it, expect } from 'vitest';
import { toVectorLiteral } from '../src/embed.js';

describe('toVectorLiteral', () => {
  it('formats a vector as a bracketed comma-separated list', () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe('[1,2.5,-3]');
  });

  it('handles an empty vector', () => {
    expect(toVectorLiteral([])).toBe('[]');
  });
});
