/**
 * runner.ts -- Migration graph walker and applier.
 *
 * Given a starting version (read from state.json) and a target version (the
 * currently-installed package version), find the linear path of migrations
 * to apply and run them in order.
 *
 * Migrations form a directed graph: each Migration declares `from` and `to`.
 * The runner walks from start to target by repeatedly finding the migration
 * whose `from` matches the current cursor. Keep the registry linear.
 */

import type { Migration, MigrationContext, MigrationResult } from './migrations/types.js';
import { MIGRATIONS } from './migrations/index.js';
import type { InstallState } from './state.js';

export interface UpgradePlan {
  from: string;
  to: string;
  migrations: Migration[];
  blocker?: string;
}

export function compareVersions(a: string, b: string): number {
  // Semver-aware enough for our needs: numeric core compare, and a release
  // outranks any prerelease of the same core (1.0.0 > 1.0.0-rc.1). Prerelease
  // vs prerelease falls back to plain string comparison, which is correct for
  // the rc.N / beta.N tags we actually publish.
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const hyphen = v.indexOf('-');
    const core = hyphen === -1 ? v : v.slice(0, hyphen);
    const pre = hyphen === -1 ? null : v.slice(hyphen + 1);
    const nums = core.split('.').map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

export function planMigrations(from: string, to: string): UpgradePlan {
  if (from === to) {
    return { from, to, migrations: [] };
  }
  if (compareVersions(from, to) > 0) {
    return {
      from, to, migrations: [],
      blocker:
        `Installed version (${from}) is newer than the CLI version (${to}). ` +
        `Refusing to downgrade.`,
    };
  }

  const ordered: Migration[] = [];
  let cursor = from;
  const seen = new Set<string>();

  while (cursor !== to) {
    if (seen.has(cursor)) {
      return { from, to, migrations: [], blocker: `Cycle detected at ${cursor}.` };
    }
    seen.add(cursor);
    const next = MIGRATIONS.find((m) => m.from === cursor);
    if (!next) {
      return {
        from, to, migrations: [],
        blocker:
          `No migration from ${cursor} to ${to}. The CLI may be newer than ` +
          `the available migration set; run 'init --force' to re-apply ` +
          `templates against ${to} directly.`,
      };
    }
    ordered.push(next);
    cursor = next.to;
  }
  return { from, to, migrations: ordered };
}

export interface ApplyAllOptions {
  ctx: Omit<MigrationContext, 'state'> & { state: InstallState };
  plan: UpgradePlan;
  /**
   * Invoked with the updated InstallState after EACH successful migration so
   * a crash mid-chain resumes from the last completed step instead of
   * replaying already-applied migrations. Callers typically pass
   * `(s) => writeState(cwd, s)`. Omit for dry runs.
   */
  persistState?: (state: InstallState) => void | Promise<void>;
}

export interface ApplyAllResult {
  appliedCount: number;
  results: Array<{ migration: Migration; result: MigrationResult }>;
  finalState: InstallState;
}

export async function applyAll(opts: ApplyAllOptions): Promise<ApplyAllResult> {
  const { plan, ctx, persistState } = opts;
  let state = { ...ctx.state };
  const results: ApplyAllResult['results'] = [];

  for (const migration of plan.migrations) {
    const migCtx: MigrationContext = { ...ctx, state };
    const result = await migration.apply(migCtx);
    results.push({ migration, result });
    state = {
      ...state,
      version: migration.to,
      lastUpgradedAt: new Date().toISOString(),
      managedFiles: result.managedFiles,
    };
    if (persistState) {
      await persistState(state);
    }
  }

  return { appliedCount: results.length, results, finalState: state };
}
