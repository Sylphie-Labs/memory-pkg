/**
 * feedback/record-injection.ts -- Persist what was injected so a later rating
 * can target the exact event rows (and the rate hook can re-quote them).
 *
 * Two independent best-effort writes (a failure of either must never break the
 * injection itself — the waking path stays resilient):
 *   1. a memory_injections row (DB), and
 *   2. a sidecar line in .claude/memory/injections/<session_id>.jsonl (the
 *      ledger the zero-DB Stop rate hook reads).
 *
 * The injection_id is generated in-process so it can be printed inside the
 * injected <memory-context> block — the model then references it verbatim when
 * rating, no reconstruction needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { runQuery } from '../timescale-client.js';

export interface InjectionItem {
  item_id: string;
  item_kind: 'event' | 'fact';
  summary120: string;
}

export interface RecordInjectionOptions {
  sessionId: string | null;
  trigger: 'prompt' | 'ambient';
  queryOrEntity: string;
  items: InjectionItem[];
  charsInjected: number;
  shadowScores?: Record<string, { merged: number; multiplier: number; effective: number }>;
  /** Override the project dir (tests). Defaults to CLAUDE_PROJECT_DIR ?? cwd. */
  projectDir?: string;
}

function ledgerPath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, '.claude', 'memory', 'injections', `${sessionId}.jsonl`);
}

export async function recordInjection(opts: RecordInjectionOptions): Promise<string> {
  const injectionId = randomUUID();
  const ts = new Date().toISOString();

  // 1. DB row (best effort).
  try {
    await runQuery(
      `INSERT INTO memory_injections
         (injection_id, ts, session_id, trigger, query_or_entity, item_ids, item_kinds, chars_injected, shadow_scores)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6::uuid[], $7::text[], $8, $9::jsonb)`,
      [
        injectionId,
        ts,
        opts.sessionId,
        opts.trigger,
        opts.queryOrEntity.slice(0, 500),
        opts.items.map((it) => it.item_id),
        opts.items.map((it) => it.item_kind),
        opts.charsInjected,
        opts.shadowScores ? JSON.stringify(opts.shadowScores) : null,
      ],
    );
  } catch {
    // DB down or row write failed — the ledger still drives the rating loop,
    // and an orphan rating is legal (no FK). Never throw.
  }

  // 2. Ledger sidecar (best effort).
  try {
    const projectDir = opts.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const sessionId = opts.sessionId ?? 'unknown';
    const file = ledgerPath(projectDir, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      injection_id: injectionId,
      ts,
      trigger: opts.trigger,
      items: opts.items.map((it) => ({
        item_id: it.item_id,
        item_kind: it.item_kind,
        summary120: it.summary120.slice(0, 120),
      })),
    });
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {
    // ledger write failed — DB row (if it landed) still allows offline analysis.
  }

  return injectionId;
}
