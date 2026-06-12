/**
 * 0.5.0 → 0.5.1 -- Deep consolidation pass + orphan transcript sweep.
 *
 * What 0.5.1 changes in a consumer repo:
 *
 *   1. `.claude/settings.json` — a SessionStart hook is added:
 *      `npx -y @sylphie-labs/memory-pkg consolidate --deep --if-stale 24`.
 *      This runs the corpus-grain deep pass (orphan-transcript sweep, embedding
 *      backlog, cross-session rationale backlog) at most once per 24h, cheaply
 *      no-opping otherwise. The orphan sweep recovers transcript tails that a
 *      killed terminal left stranded past the per-session byte cursor (bug B2).
 *
 * Settings-only; no hook files or database schema change. installSettings is
 * idempotent and degrades to printing a snippet on unparseable JSON.
 */

import { installSettings } from '../../cli/init.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration_0_5_0_to_0_5_1: Migration = {
  from: '0.5.0',
  to: '0.5.1',
  severity: 'patch',
  description:
    'Add the SessionStart deep-consolidation hook (orphan sweep + backlogs, ' +
    '--if-stale 24)',
  notes:
    'Adds a SessionStart hook running `consolidate --deep --if-stale 24`. The ' +
    'deep pass back-captures transcript tails stranded by killed terminals ' +
    '(bug B2), drains the embedding and rationale backlogs, and self-throttles ' +
    'to once per 24h. settings.json-only; no hook files or schema change.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];

    try {
      installSettings(ctx.cwd, { force: ctx.force, dryRun: ctx.dryRun });
    } catch (err) {
      warnings.push(
        `could not merge the SessionStart deep-consolidation hook into ` +
          `.claude/settings.json (${err instanceof Error ? err.message : String(err)}); ` +
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

export default migration_0_5_0_to_0_5_1;
