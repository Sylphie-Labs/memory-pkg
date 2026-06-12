/**
 * facts.int.test.ts -- Phase 7: the curated hot tier (schema v4).
 *
 * Covers: the facts retrieval tier + its tie-break (a fact outranks a raw event
 * at equal score), promotion from a high-usefulness cluster (stubbed
 * synthesizer), supersession (one active fact per cluster), and staleness
 * retirement.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool, runQuery } from '../../src/timescale-client.js';
import { generateInjection } from '../../src/inject/generate.js';
import { runConsolidation } from '../../src/consolidate/runner.js';
import { entityLinkProcessor } from '../../src/consolidate/processors/entity-link.js';
import { factsPromoteProcessor, setFactSynthesizer } from '../../src/consolidate/processors/facts-promote.js';
import { factsStalenessProcessor } from '../../src/consolidate/processors/facts-staleness.js';

let db: TestDb | undefined;
let project: string;
// Unique CLAUDE_PROJECT_DIR so runConsolidation's lock is per-file.
function env() { return { ...db!.env, MEMORY_PKG_EMBED_FAKE: '1', CLAUDE_PROJECT_DIR: project }; }

beforeAll(async () => {
  try { db = await createTestDb(); } catch { return; }
  project = mkdtempSync(path.join(tmpdir(), 'mpkg-facts-'));
});
afterAll(async () => { await closePool(); await db?.drop(); if (project) rmSync(project, { recursive: true, force: true }); });

describe('facts tier + tie-break (Phase 7)', () => {
  it('a curated fact is retrieved and outranks a raw event about the same topic', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(env(), async () => {
      // A raw event and a fact, both about "GizmoCore".
      await seedEvents(db!.env, [
        { ts: '2026-05-01T10:00:00.000Z', session_id: 'past', event_type: 'assistant_text',
          summary: 'RAW gizmocore note', excerpt: 'RAW gizmocore note',
          search_text: 'assistant_text the gizmocore widget note' },
      ]);
      await runQuery(
        `INSERT INTO memory_facts (cluster_key, fact_text, search_text, source_event_ids, derived_through_ts, status)
         VALUES ('gizmocore', 'FACT GizmoCore is the core widget.', 'gizmocore FACT GizmoCore is the core widget',
                 ARRAY[]::uuid[], NOW(), 'active')`,
      );

      const block = await generateInjection({ query: 'gizmocore', currentSessionId: 'cur' });
      const fi = block.indexOf('FACT GizmoCore');
      const ri = block.indexOf('RAW gizmocore');
      expect(fi).toBeGreaterThanOrEqual(0); // fact retrieved
      if (ri >= 0) expect(fi).toBeLessThan(ri); // and ranked above the raw event
    });
  });
});

describe('facts promotion + supersession + staleness', () => {
  it('promotes a high-usefulness cluster, supersedes on re-promotion, retires when mean drops', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    const restore = setFactSynthesizer(async () => 'PromoteMe is a reusable widget used across the app.');
    try {
      await withEnvAsync(env(), async () => {
        // An assistant_text mentioning PromoteMe → entity-link makes the cluster.
        const E1 = 'eeee0001-0000-0000-0000-000000000001';
        await seedEvents(db!.env, [
          { event_id: E1, ts: '2026-05-05T10:00:00.000Z', session_id: 'past', event_type: 'assistant_text',
            summary: 'PromoteMe wiring', excerpt: 'PromoteMe wiring details',
            search_text: 'assistant_text PromoteMe wiring details' },
        ]);
        await runConsolidation({ deep: true, processors: [entityLinkProcessor] });
        // High usefulness on the linked event.
        await runQuery(
          `INSERT INTO memory_event_stats (item_id, n_self, sum_self, last_rated_at)
           VALUES ($1, 3, 3, NOW())`,
          [E1],
        );

        // Promote.
        await runConsolidation({ deep: true, processors: [factsPromoteProcessor] });
        let facts = await runQuery<{ fact_id: string; status: string }>(
          `SELECT fact_id, status FROM memory_facts WHERE cluster_key = 'promoteme'`,
        );
        expect(facts.filter((f) => f.status === 'active').length).toBe(1);

        // Idempotent: re-promote with no newer event creates nothing.
        await runConsolidation({ deep: true, processors: [factsPromoteProcessor] });
        facts = await runQuery(`SELECT fact_id, status FROM memory_facts WHERE cluster_key = 'promoteme'`);
        expect(facts.length).toBe(1);

        // A newer qualifying event → supersession (still exactly one active).
        const E2 = 'eeee0002-0000-0000-0000-000000000002';
        await seedEvents(db!.env, [
          { event_id: E2, ts: '2026-05-06T10:00:00.000Z', session_id: 'past', event_type: 'assistant_text',
            summary: 'PromoteMe update', excerpt: 'PromoteMe update details',
            search_text: 'assistant_text PromoteMe update details' },
        ]);
        await runConsolidation({ deep: true, processors: [entityLinkProcessor] });
        await runQuery(`INSERT INTO memory_event_stats (item_id, n_self, sum_self, last_rated_at) VALUES ($1, 3, 3, NOW())`, [E2]);
        await runConsolidation({ deep: true, processors: [factsPromoteProcessor] });
        facts = await runQuery(`SELECT fact_id, status FROM memory_facts WHERE cluster_key = 'promoteme'`);
        expect(facts.length).toBe(2);
        expect(facts.filter((f) => f.status === 'active').length).toBe(1);
        expect(facts.filter((f) => f.status === 'superseded').length).toBe(1);

        // Drive the cluster mean negative → staleness retires the active fact.
        await runQuery(`UPDATE memory_event_stats SET sum_self = -3 WHERE item_id IN ($1, $2)`, [E1, E2]);
        await runConsolidation({ deep: true, processors: [factsStalenessProcessor] });
        facts = await runQuery(`SELECT status FROM memory_facts WHERE cluster_key = 'promoteme'`);
        expect(facts.filter((f) => f.status === 'active').length).toBe(0);
      });
    } finally {
      restore();
    }
  });
});
