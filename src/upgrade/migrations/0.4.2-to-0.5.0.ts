/**
 * 0.4.2 → 0.5.0 -- The consolidation entrypoint lands.
 *
 * What 0.5.0 changes in a consumer repo:
 *
 *   1. `.claude/settings.json` — the Stop-hook chain
 *      `npx ... ingest && npx ... rationale --limit 20` is replaced by a single
 *      `npx -y @sylphie-labs/memory-pkg consolidate`. consolidate owns ingest +
 *      rationale (and future derived-write processors) behind one shared lock
 *      with an internal time budget, instead of relying on the 120s hook
 *      timeout as the budget. installSettings()'s `replaces` rule strips the
 *      old `memory-pkg ingest` entry and merges the new one idempotently.
 *
 * No database schema change (SCHEMA_VERSION stays 1). No hook .cjs files change
 * (consolidate runs via npx, not a bundled hook script). Settings-only.
 *
 * If .claude/settings.json is unparseable, installSettings degrades to printing
 * a hand-merge snippet — the upgrade is not aborted.
 */

import { installSettings } from '../../cli/init.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration_0_4_2_to_0_5_0: Migration = {
  from: '0.4.2',
  to: '0.5.0',
  severity: 'minor',
  description:
    'Replace the Stop-hook `ingest && rationale` chain with a single ' +
    '`memory-pkg consolidate` entry (one lock, internal budget)',
  notes:
    'The old `ingest && rationale` Stop command is removed and replaced by ' +
    '`npx -y @sylphie-labs/memory-pkg consolidate`. This is a settings.json-only ' +
    'change; no hook files or database schema are touched. If settings.json is ' +
    'not valid JSON, a hand-merge snippet is printed instead.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];

    try {
      installSettings(ctx.cwd, { force: ctx.force, dryRun: ctx.dryRun });
    } catch (err) {
      warnings.push(
        `could not merge the consolidate hook into .claude/settings.json ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `run \`memory-pkg init --hooks-only --force\` or merge the snippet by hand.`,
      );
    }

    return {
      managedFiles: ctx.state.managedFiles.map((f) => ({ ...f })),
      changedFiles: [],
      warnings,
    };
  },
};

export default migration_0_4_2_to_0_5_0;
