/**
 * types.ts -- Migration interface contract.
 *
 * Every migration is a self-contained module that knows how to take a repo
 * from one specific version to one specific next version. The runner walks
 * the registered migrations in order from state.version to pkg.version.
 */

import type { InstallState, ManagedFile } from '../state.js';

export type MigrationSeverity = 'patch' | 'minor' | 'major';

export interface MigrationContext {
  /** Absolute path to the consumer's repo root. */
  cwd: string;
  /** Install state read from .memory-pkg/state.json before any migration runs. */
  state: InstallState;
  /** True for plan-only runs; migrations should compute changes but not write them. */
  dryRun: boolean;
  /** True when the user passed `--force`; migrations should overwrite drifted files (with .bak). */
  force: boolean;
  /** Absolute path to the package root (where dist/ lives). Useful for resolving bundled templates. */
  packageRoot: string;
  /**
   * Optional database query function (wired from timescale-client by the
   * upgrade CLI). May be undefined (DB not configured) and may THROW at call
   * time (DB unreachable). Migrations that use it MUST catch failures and
   * degrade to a warning in MigrationResult.warnings — an unreachable
   * database must never abort a file-level upgrade. File changes and DB
   * changes in one migration should be ordered files-first so a DB failure
   * leaves a consistent, re-runnable state.
   */
  runQuery?: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface MigrationResult {
  /** Updated managedFiles list reflecting any added/removed/rehashed files. */
  managedFiles: ManagedFile[];
  /** Files this migration touched (relative paths). For reporting. */
  changedFiles: string[];
  /** Soft warnings — drift skips, missing optional artifacts, etc. */
  warnings: string[];
}

export interface Migration {
  from: string;
  to: string;
  severity: MigrationSeverity;
  description: string;
  notes?: string;
  apply(ctx: MigrationContext): Promise<MigrationResult>;
}
