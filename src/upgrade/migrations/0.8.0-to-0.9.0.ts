/**
 * 0.8.0 → 0.9.0 -- Usefulness multiplier goes live (opt-in).
 *
 * No consumer-repo changes. 0.9.0 adds the `rating-mean` consolidation
 * processor (computes mu), the `memory-pkg feedback` gate report, and makes the
 * usefulness multiplier apply to ranking when MEMORY_PKG_USEFULNESS_LIVE=1 — all
 * package-side. The flag is opt-in until the feedback gate passes (D9), so
 * nothing in the repo or schema changes. This migration only advances the
 * version cursor.
 */

import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration_0_8_0_to_0_9_0: Migration = {
  from: '0.8.0',
  to: '0.9.0',
  severity: 'minor',
  description: 'Usefulness multiplier live behind MEMORY_PKG_USEFULNESS_LIVE; feedback gate report (no repo changes)',
  notes:
    '0.9.0 adds the rating-mean processor, the `memory-pkg feedback` report, and ' +
    'the live usefulness multiplier (opt-in via MEMORY_PKG_USEFULNESS_LIVE=1 once ' +
    'the gate passes). No hooks, settings, or schema change.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    return {
      managedFiles: ctx.state.managedFiles.map((f) => ({ ...f })),
      changedFiles: [],
      warnings: [],
    };
  },
};

export default migration_0_8_0_to_0_9_0;
