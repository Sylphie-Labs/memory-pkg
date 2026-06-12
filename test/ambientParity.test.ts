/**
 * ambientParity.test.ts -- D2: the vendored entity extractor inside
 * memory-ambient.cjs (the GENERATED-PARITY block) must behave identically to
 * the package extractor in src/entities/extract.ts. Drift fails the build here,
 * not in production.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { extractEntities as pkgExtract, normalizeEntity as pkgNormalize } from '../src/entities/extract.js';

const require = createRequire(import.meta.url);
const hook = require(path.resolve('template/.claude/hooks/memory-ambient.cjs'));

const CORPUS = [
  'the FilterBar date picker is acting up and not resetting',
  'grep for useDateRange in src/components/ReportsPage.tsx',
  '`memory_events` table and the reset_handler rows',
  'Edit C:/Users/Jim/Code/pkg/.claude/settings.json and package.json',
  'the MemoryEvents hypertable plus turn_rationale and assistant_thinking',
  'a "multi word phrase" and a `backtick_term` here',
  'nothing entity-like at all, just prose and words',
  'paths like /home/jim/foo/bar.ts and /c/Users/jim/baz.js',
  'CamelCase Identifiers and snake_case_names mixed together',
  '',
];

describe('memory-ambient.cjs entity-extraction parity', () => {
  it('extractEntities matches the package extractor over the corpus', () => {
    for (const s of CORPUS) {
      expect(hook.extractEntities(s)).toEqual(pkgExtract(s));
    }
  });

  it('normalizeEntity matches the package normalizer', () => {
    for (const s of ['FilterBar', '  Spaced  ', 'UPPER', 'MiXeD.tsx']) {
      expect(hook.normalizeEntity(s)).toBe(pkgNormalize(s));
    }
  });
});
