import { describe, it, expect } from 'vitest';
import { deriveSubsystem } from '../src/subsystem.js';

// MEMORY_PKG_REPO_ANCHOR is pinned to /__vitest_root__/ in vitest.config.ts so
// these relative fixture paths take the deterministic relative-path branch.
describe('deriveSubsystem', () => {
  it('returns null for absent file paths', () => {
    expect(deriveSubsystem(null)).toBeNull();
    expect(deriveSubsystem(undefined)).toBeNull();
  });

  it('maps packages/<pkg>/src/<area>/... to <pkg>/<area>', () => {
    expect(deriveSubsystem('packages/memory-pkg/src/inject/generate.ts')).toBe('memory-pkg/inject');
  });

  it('maps packages/<pkg>/src/<file> to <pkg>/src', () => {
    expect(deriveSubsystem('packages/memory-pkg/src/index.ts')).toBe('memory-pkg/src');
  });

  it('maps .claude/<subdir>/... to claude/<subdir>', () => {
    expect(deriveSubsystem('.claude/hooks/memory-inject.cjs')).toBe('claude/hooks');
  });

  it('maps a single top-level file to root', () => {
    expect(deriveSubsystem('CLAUDE.md')).toBe('root');
  });
});
