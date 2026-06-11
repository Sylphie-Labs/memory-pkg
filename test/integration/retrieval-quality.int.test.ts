/**
 * retrieval-quality.int.test.ts -- Retrieval quality benchmark (real TimescaleDB).
 *
 * Seeds controlled corpora into a single throwaway DB and asserts retrieval
 * quality metrics (recall, first-gold rank, distractor leakage) plus budget /
 * limit discipline on the formatted injection block.
 *
 * Four cases:
 *   1. Trigram recall   — gold surfaces at rank 1 against 20 noise + 2 hard negs.
 *   2. Precision        — hard negatives stay behind gold on a partial query.
 *   3. Entity recall    — identifier-only query surfaces the gold via the entity tier.
 *   4. Budget / limit   — 10 matching rows respect the char budget and DEFAULT_LIMIT.
 *
 * Cases 1-3 use scoreCase (test/helpers/retrieval-score.ts), which reads the
 * rationale trace's FinalPick[] to derive metrics. Case 4 calls generateInjection
 * directly because it asserts on the formatted output, not the trace picks.
 *
 * Determinism: the embedding tier is disabled for cases 1-3 so what surfaces
 * depends solely on the DB-lexical tiers (trigram, and entity for case 3) — no
 * ONNX model load. MEMORY_PKG_EMBED_FAKE is set regardless so any query embedding
 * (should an embedding path run) is the deterministic fakeEmbed vector.
 *
 * Skips gracefully when no TimescaleDB is reachable (createTestDb throws in
 * beforeAll): every `it` guards itself with ctx.skip() at runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, withEnvAsync, type TestDb } from '../helpers/db.js';
import { seedCorpus, type CorpusEvent } from '../helpers/corpus-seeder.js';
import { scoreCase } from '../helpers/retrieval-score.js';
import { closePool } from '../../src/timescale-client.js';
import { generateInjection } from '../../src/inject/generate.js';

let db: TestDb | undefined;

// event_ids returned by each corpus seed, keyed by role for the scoreCase inputs.
let trigramGoldIds: string[] = [];
let trigramNegIds: string[] = [];
let entityGoldIds: string[] = [];
let entityNegIds: string[] = [];

/**
 * Run fn against the test DB's env with a chosen set of tiers active. The
 * singleton pool caches its connection config on the first getPool(); resetting
 * it inside the env scope forces resolution against the throwaway database.
 *
 * `entity` toggles the entity tier (default off). The embedding tier is always
 * disabled here — cases 1-3 want lexical determinism with no model load.
 * MEMORY_PKG_EMBED_FAKE is set so any embedding work is deterministic.
 */
async function withDb<T>(fn: () => Promise<T>, opts?: { entity?: boolean }): Promise<T> {
  return withEnvAsync(db!.env, async () => {
    await closePool();
    process.env.MEMORY_PKG_EMBED_FAKE = '1';
    process.env.DRIFT_MEMORY_TIER_EMBEDDING_DISABLED = '1';
    if (opts?.entity) {
      process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED = '0';
    } else {
      process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED = '1';
    }
    try {
      return await fn();
    } finally {
      delete process.env.MEMORY_PKG_EMBED_FAKE;
      delete process.env.DRIFT_MEMORY_TIER_EMBEDDING_DISABLED;
      delete process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED;
      await closePool();
    }
  });
}

// ── Corpus 1: trigram recall / precision (cases 1 & 2) ──────────────────────
// 20 noise rows of diverse, unrelated dev text (no overlap with the query),
// 1 gold about HNSW/pgvector index rebuild, 2 hard negatives that mention HNSW
// or pgvector in an unrelated context.
const TRIGRAM_NOISE: string[] = [
  'git rebase main onto feature branch then force push with lease to update the open PR',
  'npm install eslint prettier and wire up the lint-staged pre-commit hook for the repo',
  'centered the modal with flexbox align-items center and justify-content center in CSS',
  'wrote a multi-stage Dockerfile that builds the node app then copies dist into a slim runtime',
  'configured nginx as a reverse proxy with gzip compression and a 30 second proxy timeout',
  'added a GitHub Actions workflow that runs the test matrix across node 18 20 and 22',
  'bumped the typescript version to 5.4 and fixed the resulting strict null check errors',
  'set up tailwind dark mode using the class strategy and a theme toggle button component',
  'cached the npm dependencies in CI keyed on the lockfile hash to speed up cold builds',
  'refactored the express router into separate route modules grouped by resource type',
  'debugged a flaky cypress test by adding an explicit wait for the network idle event',
  'migrated the build from webpack to vite and dropped the babel transform pipeline',
  'wrote a bash script that rotates the application log files and gzips anything older than a week',
  'styled the data table with sticky headers zebra striping and a hover highlight in CSS',
  'enabled HTTP/2 on the load balancer and set up TLS termination with a wildcard cert',
  'added retry with exponential backoff to the outbound webhook delivery queue worker',
  'fixed a memory leak in the websocket server by clearing the heartbeat interval on close',
  'set up prettier import sorting and removed the unused lodash imports across the codebase',
  'wrote unit tests for the date formatting utility covering timezone edge cases at DST',
  'configured the s3 bucket lifecycle policy to expire temp uploads after seven days',
];

const TRIGRAM_GOLD_TEXT =
  'fixed the HNSW index rebuild latency after pgvector upgrade on timescale';

const TRIGRAM_NEGATIVES: string[] = [
  'disabled HNSW for the classifier model because the ANN graph hurt inference accuracy',
  'benchmarked pgvector against a brute force scan for the recommendation embeddings job',
];

// ── Corpus 2: entity recall (case 3) ────────────────────────────────────────
// 15 noise rows, 1 gold mentioning the usePaymentLedger identifier, 2 hard
// negatives that mention "refactored hook" but NOT the identifier.
const ENTITY_NOISE: string[] = [
  'git cherry-pick the hotfix commit onto the release branch and tag a patch version',
  'npm audit fix resolved the transitive vulnerability in the markdown parser dependency',
  'styled the sidebar navigation with a CSS grid and collapsible section accordions',
  'wrote a Dockerfile healthcheck that curls the readiness endpoint every ten seconds',
  'configured eslint no-floating-promises to catch unawaited async calls in the services',
  'added pagination to the orders list using cursor based keyset pagination in the query',
  'set up a redis cache layer in front of the product catalog read endpoints',
  'migrated the postgres schema with a zero downtime backfill of the new status column',
  'tuned the garbage collector flags to reduce pause times on the reporting workload',
  'wrote integration tests for the auth middleware covering expired and malformed tokens',
  'refactored the notification service to batch emails and dedupe by recipient address',
  'fixed a CSS specificity bug where the utility class lost to a component scoped style',
  'added a feature flag to gate the new checkout flow behind a percentage rollout',
  'wrote a script to seed the staging database with anonymized production fixtures',
  'configured the CDN to cache immutable hashed assets for one year with stale-while-revalidate',
];

const ENTITY_GOLD_TEXT = 'refactored usePaymentLedger hook to fix race condition';

const ENTITY_NEGATIVES: string[] = [
  'refactored the useCart hook to memoize selectors and avoid needless re-renders',
  'refactored the useAuth hook to read the session token from the new secure cookie',
];

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    // No DB reachable — leave db undefined; every test self-skips at runtime.
    db = undefined;
  }
});

afterAll(async () => {
  if (db) {
    await closePool();
    await db.drop();
  }
});

// Seed the trigram corpus (cases 1 & 2).
beforeAll(async () => {
  if (!db) return;
  await withDb(async () => {
    const events: CorpusEvent[] = [
      ...TRIGRAM_NOISE.map((text, i): CorpusEvent => ({
        session_id: `noise-${i}`,
        event_type: 'tool_call',
        search_text: text,
        excerpt: text,
        _role: 'noise',
      })),
      {
        session_id: 'gold-trigram',
        event_type: 'assistant_text',
        search_text: TRIGRAM_GOLD_TEXT,
        excerpt: TRIGRAM_GOLD_TEXT,
        _role: 'gold',
      },
      ...TRIGRAM_NEGATIVES.map((text, i): CorpusEvent => ({
        session_id: `neg-trigram-${i}`,
        event_type: 'assistant_text',
        search_text: text,
        excerpt: text,
        _role: 'negative',
      })),
    ];
    const { eventIds } = await seedCorpus(db!.env, events, 'tri');
    // event_ids come back in insertion order: 20 noise, 1 gold, 2 negatives.
    trigramGoldIds = [eventIds[TRIGRAM_NOISE.length]];
    trigramNegIds = eventIds.slice(TRIGRAM_NOISE.length + 1);
  });
});

// Seed the entity corpus (case 3).
beforeAll(async () => {
  if (!db) return;
  await withDb(async () => {
    const events: CorpusEvent[] = [
      ...ENTITY_NOISE.map((text, i): CorpusEvent => ({
        session_id: `noise-${i}`,
        event_type: 'tool_call',
        search_text: text,
        excerpt: text,
        _role: 'noise',
      })),
      {
        session_id: 'gold-entity',
        event_type: 'assistant_text',
        search_text: ENTITY_GOLD_TEXT,
        excerpt: ENTITY_GOLD_TEXT,
        _role: 'gold',
      },
      ...ENTITY_NEGATIVES.map((text, i): CorpusEvent => ({
        session_id: `neg-entity-${i}`,
        event_type: 'assistant_text',
        search_text: text,
        excerpt: text,
        _role: 'negative',
      })),
    ];
    const { eventIds } = await seedCorpus(db!.env, events, 'ent');
    entityGoldIds = [eventIds[ENTITY_NOISE.length]];
    entityNegIds = eventIds.slice(ENTITY_NOISE.length + 1);
  }, { entity: true });
});

describe('retrieval quality benchmark (integration)', () => {
  // ── Case 1: trigram recall — gold surfaces at rank 1 ──────────────────────
  it('case 1: trigram recall puts the gold at rank 1 with no distractors before it', async (ctx) => {
    if (!db) return ctx.skip();
    const score = await withDb(() =>
      scoreCase({
        query: 'hnsw index rebuild pgvector',
        goldIds: trigramGoldIds,
        negativeIds: trigramNegIds,
        expectedTier: 'trigram',
        label: 'trigram recall',
      }),
    );
    expect(score.recall).toBeGreaterThanOrEqual(1.0);
    expect(score.firstGoldRank).toBe(1);
    expect(score.distractorsBefore).toBe(0);
  });

  // ── Case 2: precision — hard negatives rejected on a partial query ─────────
  it('case 2: precision keeps hard negatives behind the gold on a partial query', async (ctx) => {
    if (!db) return ctx.skip();
    const score = await withDb(() =>
      scoreCase({
        query: 'pgvector hnsw',
        goldIds: trigramGoldIds,
        negativeIds: trigramNegIds,
        expectedTier: 'trigram',
        label: 'trigram precision',
      }),
    );
    expect(score.distractorsBefore).toBe(0);
    expect(score.recall).toBeGreaterThanOrEqual(1.0);
  });

  // ── Case 3: entity tier recall — identifier-only query ────────────────────
  it('case 3: entity tier surfaces the gold at rank 1 for an identifier-only query', async (ctx) => {
    if (!db) return ctx.skip();
    const score = await withDb(
      () =>
        scoreCase({
          query: 'usePaymentLedger',
          goldIds: entityGoldIds,
          negativeIds: entityNegIds,
          expectedTier: 'entity',
          label: 'entity recall',
        }),
      { entity: true },
    );
    expect(score.recall).toBeGreaterThanOrEqual(1.0);
    expect(score.firstGoldRank).toBe(1);
  });

  // ── Case 4: limit and budget discipline ───────────────────────────────────
  // Uses generateInjection directly because it asserts on the formatted block
  // (char budget + DEFAULT_LIMIT) rather than the trace picks.
  it('case 4: respects the char budget and DEFAULT_LIMIT for many matching rows', async (ctx) => {
    if (!db) return ctx.skip();
    const BUDGET_TEXT = 'webhook stripe payment delivery retry queue worker pipeline';
    // ~200-char excerpts so the budget actually binds across the 10 matches.
    const longExcerpt = (BUDGET_TEXT + ' ').repeat(4).trim().padEnd(200, ' x').slice(0, 200);

    const result = await withDb(async () => {
      await seedCorpus(
        db!.env,
        Array.from({ length: 10 }, (_, i): CorpusEvent => ({
          session_id: `budget-${i}`,
          event_type: 'assistant_text',
          search_text: BUDGET_TEXT,
          excerpt: longExcerpt,
        })),
        'bud',
      );
      return generateInjection({ query: 'stripe webhook' });
    });

    expect(result.length).toBeLessThanOrEqual(4200);
    expect((result.match(/### Match/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(result).not.toBe('');
  });
});
