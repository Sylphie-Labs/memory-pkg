/**
 * 0.4.1 → 0.4.2 — Patch release: no file or schema changes.
 *
 * 0.4.2 shipped the missing 0.4.0→0.4.1 migration entry itself; there were no
 * consumer-repo changes between 0.4.1 and 0.4.2. This no-op exists so the
 * upgrade runner can advance the version cursor across 0.4.1→0.4.2 instead of
 * dead-ending with "No migration from 0.4.1" on the way to a newer release.
 */

import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration_0_4_1_to_0_4_2: Migration = {
  from: '0.4.1',
  to: '0.4.2',
  severity: 'patch',
  description: 'Patch release — no consumer-repo changes required',
  notes:
    '0.4.2 only added the previously-missing migration registry entry. No hooks, ' +
    'settings, or database schema changed. This migration advances the version cursor.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    return {
      managedFiles: ctx.state.managedFiles.map((f) => ({ ...f })),
      changedFiles: [],
      warnings: [],
    };
  },
};

export default migration_0_4_1_to_0_4_2;
