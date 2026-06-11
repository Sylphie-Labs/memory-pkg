/**
 * 0.4.0 → 0.4.1 — Patch release: no file or schema changes.
 *
 * 0.4.1 ships the retrieval-quality benchmark and embedding-backfill fix as
 * test/tooling improvements only. Nothing in the consumer repo needs to change;
 * this migration exists solely so the upgrade runner can advance the version
 * cursor without blocking on a missing migration entry.
 */

import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration_0_4_0_to_0_4_1: Migration = {
  from: '0.4.0',
  to: '0.4.1',
  severity: 'patch',
  description: 'Patch release — no consumer-repo changes required',
  notes:
    '0.4.1 adds a retrieval-quality benchmark and backfill-embeddings tooling. ' +
    'No hooks, settings, or database schema changed. This migration only advances ' +
    'the version cursor in state.json.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    return {
      managedFiles: ctx.state.managedFiles.map((f) => ({ ...f })),
      changedFiles: [],
      warnings: [],
    };
  },
};

export default migration_0_4_0_to_0_4_1;
