/**
 * entityGraph.int.test.ts -- Phase 3: the entity graph and its one-hop
 * associative recall, against a real TimescaleDB (schema v2).
 *
 * Seeds a turn where a tool_call names `FilterBar` and the turn's rationale
 * explains the "why" WITHOUT naming FilterBar. After entity-link consolidation,
 * querying the FilterBar entity must surface BOTH the tool_call (direct link)
 * and the rationale (one hop: entity → event → turn → rationale) — the recall
 * flat lexical tiers can't do.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool, runQuery } from '../../src/timescale-client.js';
import { runConsolidation } from '../../src/consolidate/runner.js';
import { entityLinkProcessor } from '../../src/consolidate/processors/entity-link.js';
import { entityTier } from '../../src/inject/tiers/entity.js';

let db: TestDb | undefined;

const UP_ID = '11111111-1111-1111-1111-111111111111';
const TOOLCALL_ID = '22222222-2222-2222-2222-222222222222';
const RAT_ID = '33333333-3333-3333-3333-333333333333';
const SESSION = 'graph-sess';

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    return;
  }
  await withEnvAsync({ ...db.env, MEMORY_PKG_EMBED_FAKE: '1' }, async () => {
    await closePool();
    await seedEvents(db!.env, [
      {
        event_id: UP_ID,
        ts: '2026-05-01T10:00:00.000Z',
        session_id: SESSION,
        event_type: 'user_prompt',
        summary: 'the date picker is acting up',
        excerpt: 'the date picker is acting up',
        search_text: 'user_prompt the date picker is acting up',
      },
      {
        event_id: TOOLCALL_ID,
        ts: '2026-05-01T10:01:00.000Z',
        session_id: SESSION,
        event_type: 'tool_call',
        summary: 'Grep FilterBar',
        excerpt: 'Grep FilterBar',
        search_text: 'tool_call Grep FilterBar src/components',
      },
      {
        // Rationale that explains the WHY but never names FilterBar.
        event_id: RAT_ID,
        ts: '2026-05-01T10:05:00.000Z',
        session_id: SESSION,
        event_type: 'turn_rationale',
        summary: 'we route date filtering through useDateRange',
        excerpt: 'we route date filtering through useDateRange',
        search_text: 'turn_rationale we route date filtering through useDateRange',
        payload: JSON.stringify({ source_user_prompt_id: UP_ID, rationale: 'date filtering via useDateRange' }),
      },
    ]);
    await closePool();
  });
});

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('entity graph (Phase 3)', () => {
  it('entity-link populates memory_entities and links from event text', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync({ ...db.env, MEMORY_PKG_EMBED_FAKE: '1' }, async () => {
      const r = await runConsolidation({ deep: true, processors: [entityLinkProcessor] });
      expect(r.ran).toBe(true);

      const ents = await runQuery<{ name_norm: string }>(
        `SELECT name_norm FROM memory_entities ORDER BY name_norm`,
      );
      const names = ents.map((e) => e.name_norm);
      expect(names).toContain('filterbar');
      // The event_type prefix in search_text must not leak as an entity.
      expect(names).not.toContain('turn_rationale');

      // The FilterBar entity is linked to the tool_call, carrying the turn anchor.
      const links = await runQuery<{ event_id: string; turn_user_prompt_id: string }>(
        `SELECT l.event_id, l.turn_user_prompt_id
         FROM memory_entity_events l JOIN memory_entities e ON e.entity_id = l.entity_id
         WHERE e.name_norm = 'filterbar'`,
      );
      expect(links.map((l) => l.event_id)).toContain(TOOLCALL_ID);
      expect(links[0].turn_user_prompt_id).toBe(UP_ID);
    });
  });

  it('one-hop recall: querying FilterBar surfaces the unrelated-by-text rationale', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync({ ...db.env, MEMORY_PKG_EMBED_FAKE: '1' }, async () => {
      // Ensure the graph is linked (idempotent if the prior test already ran).
      await runConsolidation({ deep: true, processors: [entityLinkProcessor] });

      const res = await entityTier({
        query: 'why is FilterBar involved',
        sessionId: 'other-session',
        excludeSelf: false,
      } as any);

      const ids = res.candidates.map((c) => c.event_id);
      // Direct link (the grep) AND the one-hop rationale, despite the rationale
      // text never mentioning FilterBar.
      expect(ids).toContain(TOOLCALL_ID);
      expect(ids).toContain(RAT_ID);
    });
  });

  it('is idempotent: a second entity-link pass adds no duplicate links', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync({ ...db.env, MEMORY_PKG_EMBED_FAKE: '1' }, async () => {
      await runConsolidation({ deep: true, processors: [entityLinkProcessor] });
      const before = await runQuery<{ n: string }>(`SELECT count(*)::text AS n FROM memory_entity_events`);
      await runConsolidation({ deep: true, processors: [entityLinkProcessor] });
      const after = await runQuery<{ n: string }>(`SELECT count(*)::text AS n FROM memory_entity_events`);
      expect(after[0].n).toBe(before[0].n);
    });
  });
});
