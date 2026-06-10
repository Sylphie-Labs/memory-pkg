/**
 * error-log.ts -- Best-effort diagnostic trail for silent injection failures.
 *
 * The UserPromptSubmit hook is deliberately silent on errors so it never
 * blocks a user prompt. Without any surfacing of failures, a broken inject
 * pipeline is invisible — the user just sees "no past context surfaced" and
 * has no reason to suspect a DB connection error rather than poor matching.
 *
 * When generateInjection() would return an empty block AND at least one tier
 * reported an error, we append one line to `.memory-pkg/inject-errors.log` so
 * the failure is discoverable (`memory-pkg doctor` reads it; users can tail
 * it). Writing is best-effort — a logging failure must never bubble up.
 *
 * Rotation: when the file exceeds MAX_BYTES, the current log is renamed to
 * `inject-errors.log.old` (overwriting any prior .old) and a fresh log starts.
 * One generation kept on purpose — this is a diagnostic surface, not history.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TierResult } from './tiers/types.js';

const REL_DIR = '.memory-pkg';
const FILE = 'inject-errors.log';
const MAX_BYTES = 64 * 1024;

function resolveLogPath(): string {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return path.join(root, REL_DIR, FILE);
}

function rotateIfLarge(p: string): void {
  try {
    const stat = fs.statSync(p);
    if (stat.size <= MAX_BYTES) return;
    fs.renameSync(p, p + '.old');
  } catch {
    // doesn't exist or can't stat — nothing to rotate
  }
}

/**
 * Append one line capturing the tier errors that produced an empty injection.
 * Returns true when a line was written (used by doctor to know there's data).
 */
export function appendInjectError(opts: {
  query: string;
  sessionId?: string | null;
  results: TierResult[];
  stage: 'no-merged' | 'no-ranked';
}): boolean {
  const errored = opts.results
    .filter((r) => r.error)
    .map((r) => ({ tier: r.tier, error: r.error }));
  if (errored.length === 0) return false;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    stage: opts.stage,
    // Don't write the full prompt — only its length, to keep the log
    // non-sensitive and bounded.
    query_chars: opts.query.length,
    session_id: opts.sessionId ?? null,
    tier_errors: errored,
  }) + '\n';

  try {
    const p = resolveLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfLarge(p);
    fs.appendFileSync(p, line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the most recent N lines from inject-errors.log for `doctor` to surface.
 * Returns [] if the file doesn't exist or is unreadable.
 */
export function readRecentInjectErrors(limit = 5): string[] {
  try {
    const p = resolveLogPath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}
