/**
 * ambient.int.test.ts -- Phase 5: the ambient CLI (strong/weak/empty) and the
 * referenced-check implicit cross-check, against a real TimescaleDB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createTestDb, seedEvents, withEnvAsync, type TestDb } from '../helpers/db.js';
import { closePool, runQuery } from '../../src/timescale-client.js';
import { runConsolidation } from '../../src/consolidate/runner.js';
import { entityLinkProcessor } from '../../src/consolidate/processors/entity-link.js';
import { referencedCheckProcessor } from '../../src/consolidate/processors/referenced-check.js';

let db: TestDb | undefined;
let project: string;
const CLI = path.resolve('dist/cli/memory-pkg.js');

function baseEnv(): Record<string, string> {
  return { ...db!.env, MEMORY_PKG_EMBED_FAKE: '1', CLAUDE_PROJECT_DIR: project };
}

function runAmbientCli(entities: string[], session = 'cur-session'): { text: string; injected: boolean } {
  const res = spawnSync('node', [CLI, 'ambient', '-'], {
    input: JSON.stringify({ session_id: session, entities }),
    encoding: 'utf8',
    env: { ...process.env, ...baseEnv() },
  });
  try {
    return JSON.parse((res.stdout ?? '').trim());
  } catch {
    return { text: '', injected: false };
  }
}

beforeAll(async () => {
  try {
    db = await createTestDb();
  } catch {
    return;
  }
  project = mkdtempSync(path.join(tmpdir(), 'mpkg-amb-int-'));
  await withEnvAsync(baseEnv(), async () => {
    await closePool();
    await seedEvents(db!.env, [
      // Strong: an assistant_text conclusion mentioning FilterBar (past session).
      {
        ts: '2026-05-01T10:00:00.000Z',
        session_id: 'past',
        event_type: 'assistant_text',
        summary: 'FilterBar resets the DatePicker via a clear handler',
        excerpt: 'FilterBar resets the DatePicker via a clear handler',
        search_text: 'assistant_text FilterBar resets the DatePicker via a clear handler',
      },
      // Weak: only a tool_call references WidgetThing (no conclusion content).
      {
        ts: '2026-05-01T10:01:00.000Z',
        session_id: 'past',
        event_type: 'tool_call',
        summary: 'Grep WidgetThing',
        excerpt: 'Grep WidgetThing',
        search_text: 'tool_call Grep WidgetThing',
      },
    ]);
    await closePool();
  });
  // Build the entity graph.
  await withEnvAsync(baseEnv(), async () => {
    await closePool();
    await runConsolidation({ deep: true, processors: [entityLinkProcessor] });
    await closePool();
  });
});

afterAll(async () => {
  await closePool();
  await db?.drop();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('ambient CLI (Phase 5)', () => {
  it('strong: an entity with conclusion content injects a block + records an ambient injection', async (ctx) => {
    if (!db) return ctx.skip();
    const out = runAmbientCli(['filterbar']);
    expect(out.injected).toBe(true);
    expect(out.text).toContain('ambient-memory');
    expect(out.text).toContain('FilterBar');
    expect(out.text).toMatch(/injection: [0-9a-f-]{36}/);

    await withEnvAsync(baseEnv(), async () => {
      await closePool();
      const rows = await runQuery<{ trigger: string }>(
        `SELECT trigger FROM memory_injections WHERE trigger = 'ambient'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('weak: an entity with only tool-call content returns a searchMemory hint, not a block', async (ctx) => {
    if (!db) return ctx.skip();
    const out = runAmbientCli(['widgetthing']);
    expect(out.injected).toBe(false);
    expect(out.text).toContain('searchMemory');
    expect(out.text).toContain('widgetthing');
  });

  it('empty: an unknown entity returns nothing', async (ctx) => {
    if (!db) return ctx.skip();
    const out = runAmbientCli(['nonexistententity']);
    expect(out.injected).toBe(false);
    expect(out.text).toBe('');
  });
});

describe('referenced-check (F4)', () => {
  it('marks referenced=true when a later tool_call touches the injected file', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(baseEnv(), async () => {
      const session = 'ref-yes';
      const itemId = 'aaaa1111-aaaa-1111-aaaa-111111111111';
      const injId = 'bbbb2222-bbbb-2222-bbbb-222222222222';
      // The injected (cross-session) memory has a file_path.
      await seedEvents(db!.env, [
        { event_id: itemId, ts: '2026-05-02T09:00:00.000Z', session_id: 'past', event_type: 'assistant_text',
          file_path: 'src/FilterBar.tsx', excerpt: 'x', summary: 'x', search_text: 'x' },
      ]);
      // An injection delivered into `session` at T.
      await runQuery(
        `INSERT INTO memory_injections (injection_id, ts, session_id, trigger, item_ids, item_kinds, chars_injected)
         VALUES ($1, '2026-05-02T10:00:00.000Z', $2, 'prompt', ARRAY[$3]::uuid[], ARRAY['event']::text[], 100)`,
        [injId, session, itemId],
      );
      // A later tool_call in `session` touches the same file.
      await seedEvents(db!.env, [
        { ts: '2026-05-02T10:05:00.000Z', session_id: session, event_type: 'tool_call',
          file_path: 'src/FilterBar.tsx', excerpt: 'Edit', summary: 'Edit FilterBar', search_text: 'tool_call Edit FilterBar' },
      ]);

      await runConsolidation({ sessionId: session, processors: [referencedCheckProcessor] });

      const rows = await runQuery<{ rating: number; referenced: boolean }>(
        `SELECT rating, referenced FROM memory_ratings WHERE injection_id = $1 AND source = 'implicit'`,
        [injId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].referenced).toBe(true);
      expect(rows[0].rating).toBe(1);
    });
  });

  it('marks referenced=false when nothing touches the injected memory', async (ctx) => {
    if (!db) return ctx.skip();
    await closePool();
    await withEnvAsync(baseEnv(), async () => {
      const session = 'ref-no';
      const itemId = 'cccc3333-cccc-3333-cccc-333333333333';
      const injId = 'dddd4444-dddd-4444-dddd-444444444444';
      await seedEvents(db!.env, [
        { event_id: itemId, ts: '2026-05-03T09:00:00.000Z', session_id: 'past', event_type: 'assistant_text',
          file_path: 'src/Untouched.tsx', excerpt: 'y', summary: 'y', search_text: 'y' },
      ]);
      await runQuery(
        `INSERT INTO memory_injections (injection_id, ts, session_id, trigger, item_ids, item_kinds, chars_injected)
         VALUES ($1, '2026-05-03T10:00:00.000Z', $2, 'prompt', ARRAY[$3]::uuid[], ARRAY['event']::text[], 100)`,
        [injId, session, itemId],
      );
      // A later unrelated tool_call (different file).
      await seedEvents(db!.env, [
        { ts: '2026-05-03T10:05:00.000Z', session_id: session, event_type: 'tool_call',
          file_path: 'src/Other.tsx', excerpt: 'Read', summary: 'Read Other', search_text: 'tool_call Read Other' },
      ]);

      await runConsolidation({ sessionId: session, processors: [referencedCheckProcessor] });

      const rows = await runQuery<{ rating: number; referenced: boolean }>(
        `SELECT rating, referenced FROM memory_ratings WHERE injection_id = $1 AND source = 'implicit'`,
        [injId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].referenced).toBe(false);
      expect(rows[0].rating).toBe(0);
    });
  });
});
