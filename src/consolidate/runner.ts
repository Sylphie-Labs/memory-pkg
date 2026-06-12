/**
 * consolidate/runner.ts -- The single entrypoint owning all derived writes.
 *
 * runConsolidation() acquires one shared lock, runs the registered processors
 * for the current cadence (tick or deep) within an overall time budget, and
 * releases the lock. It replaces the old `npx ingest && npx rationale` Stop
 * chain: one process, one lock, internal budget (not the hook timeout).
 *
 *   - tick (default): turn-grain. ctx.sessionId is the just-finished session.
 *     Budget 90s (under the 120s Stop-hook timeout).
 *   - deep (--deep):  corpus-grain. No session filter. Budget 10min. Records
 *     deep_last_ran_at so --if-stale can cheaply no-op on the next run.
 *
 * Everything fails open: a missing/locked lock, an unreachable DB, or a
 * throwing processor degrades to "did less work", never to a thrown error
 * that could surface in a hook.
 */

import * as fs from 'fs';
import * as path from 'path';
import { acquireNamedLock, releaseNamedLock } from './lock.js';
import { PROCESSORS } from './processors/index.js';
import { getMeta, setMeta } from './meta.js';
import type { Processor, ProcessorContext } from './types.js';

const LOCK_NAME = 'consolidate.lock';
const TICK_STALE_MS = 15 * 60 * 1000;
const DEEP_STALE_MS = 45 * 60 * 1000;
const DEFAULT_TICK_BUDGET_MS = 90_000;
const DEFAULT_DEEP_BUDGET_MS = 10 * 60 * 1000;
const DEEP_LAST_RAN_KEY = 'deep_last_ran_at';

export interface ConsolidateOptions {
  deep?: boolean;
  sessionId?: string;
  budgetMs?: number;
  /** Deep only: skip the run entirely if the last deep pass was < this many hours ago. */
  ifStaleHours?: number;
  /** Override the .claude/memory dir (tests). Defaults to CLAUDE_PROJECT_DIR/.claude/memory. */
  bufferDir?: string;
  /** Override the processor registry (tests). Defaults to the real PROCESSORS. */
  processors?: Processor[];
}

export interface ConsolidateResult {
  ran: boolean;
  skipped?: 'locked' | 'fresh';
  deep: boolean;
  budgetMs: number;
  processors: Array<{ name: string; processed: number; skipped: number; exhausted: boolean }>;
}

function memoryDir(opts: ConsolidateOptions): string {
  if (opts.bufferDir) return opts.bufferDir;
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return path.join(projectDir, '.claude', 'memory');
}

function makeLogger(memDir: string, deep: boolean): (line: string) => void {
  const logPath = path.join(memDir, 'consolidate-log.jsonl');
  return (line: string) => {
    try {
      fs.appendFileSync(
        logPath,
        JSON.stringify({ ts: new Date().toISOString(), kind: deep ? 'deep' : 'tick', line }) + '\n',
      );
    } catch {
      // logging is best-effort; never let it break a run
    }
  };
}

export async function runConsolidation(opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
  const deep = !!opts.deep;
  const budgetMs = opts.budgetMs ?? (deep ? DEFAULT_DEEP_BUDGET_MS : DEFAULT_TICK_BUDGET_MS);
  const memDir = memoryDir(opts);
  const base: Omit<ConsolidateResult, 'ran' | 'skipped'> = { deep, budgetMs, processors: [] };

  // Deep staleness guard: cheap no-op when a recent deep pass already ran.
  if (deep && opts.ifStaleHours !== undefined) {
    const last = await getMeta(DEEP_LAST_RAN_KEY);
    if (last) {
      const ageMs = Date.now() - new Date(last).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < opts.ifStaleHours * 3_600_000) {
        return { ran: false, skipped: 'fresh', ...base };
      }
    }
  }

  const staleMs = deep ? DEEP_STALE_MS : TICK_STALE_MS;
  if (!acquireNamedLock(memDir, LOCK_NAME, staleMs)) {
    return { ran: false, skipped: 'locked', ...base };
  }

  const log = makeLogger(memDir, deep);
  const results: ConsolidateResult['processors'] = [];
  const overallDeadline = Date.now() + budgetMs;
  const processors = opts.processors ?? PROCESSORS;

  try {
    for (const p of processors) {
      const applies = deep ? p.cadence !== 'tick' : p.cadence !== 'deep';
      if (!applies) continue;

      const remaining = overallDeadline - Date.now();
      if (remaining <= 0) {
        log(`budget exhausted before ${p.name}`);
        break;
      }

      const ctx: ProcessorContext = {
        sessionId: deep ? undefined : opts.sessionId,
        deadline: Date.now() + remaining,
        deep,
        bufferDir: memDir,
        log,
      };

      try {
        const r = await p.run(ctx);
        results.push({ name: p.name, processed: r.processed, skipped: r.skipped, exhausted: r.exhausted });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`processor ${p.name} error: ${msg}`);
        results.push({ name: p.name, processed: 0, skipped: 0, exhausted: false });
      }
    }

    if (deep) {
      // Best-effort: a DB-down deep pass still did its no-DB work (orphan sweep).
      await setMeta(DEEP_LAST_RAN_KEY, new Date().toISOString()).catch(() => {});
    }
  } finally {
    releaseNamedLock(memDir, LOCK_NAME);
  }

  return { ran: true, deep, budgetMs, processors: results };
}
