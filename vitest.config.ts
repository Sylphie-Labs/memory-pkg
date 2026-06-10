import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/integration/**', 'test/e2e/**'],
    environment: 'node',
    // subsystem.ts derives its repo-root anchor from `git rev-parse` against the
    // cwd. Pin it to a sentinel that never appears inside test fixture paths so
    // path→subsystem derivation is deterministic wherever the suite runs.
    env: {
      MEMORY_PKG_REPO_ANCHOR: '/__vitest_root__/',
    },
  },
});
