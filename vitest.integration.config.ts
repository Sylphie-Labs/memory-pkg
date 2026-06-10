import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'test/integration/**/*.int.test.ts',
      'test/e2e/**/*.e2e.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,   // integration tests can be slow
    hookTimeout: 15000,
    // Skip gracefully when DB isn't running:
    // Tests themselves use createTestDb() which will throw; we rely on
    // vitest's test.skipIf / beforeAll try/catch to skip rather than a
    // global skip here. Do NOT add globalSetup here — let each suite manage its DB.
    env: {
      MEMORY_PKG_REPO_ANCHOR: '/__vitest_root__/',
      MEMORY_PKG_EMBED_FAKE: '1',  // always use fake embedder in integration tests
    },
  },
});
