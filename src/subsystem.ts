/**
 * subsystem.ts -- Derive a subsystem tag from an event's file_path.
 *
 * Subsystems are coarse buckets used for entity-based lookup and filtering.
 * Derivation is deterministic and path-based so backfill and ingest
 * agree. Events with no file_path get subsystem = null.
 *
 * The repo-root anchor is auto-detected once per process via
 * `git rev-parse --show-toplevel` against the cwd. Override with the
 * MEMORY_PKG_REPO_ANCHOR env var (an absolute path) when running outside a git
 * repo or when the cwd isn't your project root.
 *
 * Examples (for a project rooted at /home/me/my-app/):
 *   packages/memory-pkg/src/inject/generate.ts  -> memory-pkg/inject
 *   .claude/hooks/memory-inject.cjs             -> claude/hooks
 *   docs/plans/memory-pkg-tier-plan.md          -> docs/plans
 *   CLAUDE.md                                   -> root
 */

import { execSync } from 'child_process';
import { runQuery } from './timescale-client.js';

const FILE_EXT_RE = /\.[A-Za-z0-9]{1,6}$/;
const isFile = (seg: string): boolean => FILE_EXT_RE.test(seg);

let _repoAnchor: string | null | undefined;

/**
 * Returns the project-root anchor used to strip absolute paths down to their
 * repo-relative form. Format: "/<lastSegment>/" so substring matching works
 * across drives and mounts. Cached for the life of the process.
 *
 * Resolution order:
 *   1. MEMORY_PKG_REPO_ANCHOR env var (absolute path).
 *   2. `git rev-parse --show-toplevel` against process.cwd().
 *   3. null — caller falls back to relative-path heuristics.
 */
function getRepoAnchor(): string | null {
  if (_repoAnchor !== undefined) return _repoAnchor;

  const envOverride = process.env.MEMORY_PKG_REPO_ANCHOR;
  if (envOverride) {
    const normalized = envOverride.replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSegment = normalized.split('/').pop();
    _repoAnchor = lastSegment ? `/${lastSegment}/` : null;
    return _repoAnchor;
  }

  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) {
      const normalized = top.replace(/\\/g, '/').replace(/\/+$/, '');
      const lastSegment = normalized.split('/').pop();
      _repoAnchor = lastSegment ? `/${lastSegment}/` : null;
      return _repoAnchor;
    }
  } catch {
    // Not a git repo, or git not installed. Fall through.
  }

  _repoAnchor = null;
  return _repoAnchor;
}

export function deriveSubsystem(filePath: string | null | undefined): string | null {
  if (!filePath) return null;

  const normalized = filePath.replace(/\\/g, '/');
  const anchor = getRepoAnchor();

  let rel: string;
  if (anchor) {
    const idx = normalized.lastIndexOf(anchor);
    if (idx >= 0) {
      rel = normalized.slice(idx + anchor.length);
    } else if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
      // Absolute path outside the configured repo root → different repo.
      return null;
    } else {
      rel = normalized.replace(/^\.?\/+/, '');
    }
  } else {
    // No anchor available: treat absolute paths as foreign, relative as local.
    if (/^[A-Za-z]:\//.test(normalized)) return null;
    if (normalized.startsWith('/')) return null;
    rel = normalized.replace(/^\.?\/+/, '');
  }

  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const head = parts[0];

  // packages/<pkg>/src/<area>/...  -> <pkg>/<area>   (only if <area> is a directory)
  // packages/<pkg>/src/<file>      -> <pkg>/src
  if (head === 'packages' && parts.length >= 4 && parts[2] === 'src') {
    if (isFile(parts[3])) return `${parts[1]}/src`;
    return `${parts[1]}/${parts[3]}`;
  }
  // packages/<pkg>/...  -> <pkg>
  if (head === 'packages' && parts.length >= 2) {
    return parts[1];
  }
  // .claude/<subdir>/...  -> claude/<subdir>
  // .claude/<file>        -> claude
  if (head === '.claude') {
    if (parts.length >= 2 && !isFile(parts[1])) return `claude/${parts[1]}`;
    return 'claude';
  }
  // wiki/<subdir>/... -> wiki/<subdir>;  wiki/<file> -> wiki
  if (head === 'wiki') {
    if (parts.length >= 2 && !isFile(parts[1])) return `wiki/${parts[1]}`;
    return 'wiki';
  }
  // docs/<subdir>/... -> docs/<subdir>
  if (head === 'docs') {
    if (parts.length >= 2 && !isFile(parts[1])) return `docs/${parts[1]}`;
    return 'docs';
  }
  // Single top-level file (CLAUDE.md, package.json, turbo.json)
  if (parts.length === 1) return 'root';

  return head;
}

export async function backfillSubsystems(): Promise<{ scanned: number; updated: number }> {
  // Scan all rows (not just NULL subsystem) so re-derivation can correct past mistakes.
  // UPDATE fires only when the derived value differs from what's stored.
  const rows = await runQuery<{ event_id: string; ts: string; file_path: string | null; subsystem: string | null }>(
    `SELECT event_id, ts, file_path, subsystem FROM memory_events`,
  );
  let updated = 0;
  for (const row of rows) {
    const sub = deriveSubsystem(row.file_path);
    if (sub === row.subsystem) continue;
    // Hypertable requires ts in WHERE for efficient UPDATE (primary key is (ts, event_id)).
    await runQuery(
      `UPDATE memory_events SET subsystem = $1 WHERE event_id = $2 AND ts = $3`,
      [sub, row.event_id, row.ts],
    );
    updated++;
  }
  return { scanned: rows.length, updated };
}
