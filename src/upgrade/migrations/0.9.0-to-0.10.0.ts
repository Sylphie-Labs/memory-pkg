/**
 * 0.9.0 → 0.10.0 -- The curated hot tier (schema v4).
 *
 * Adds memory_facts (plain, mutable, consolidation-owned): distilled facts
 * promoted from high-usefulness entity clusters, served as a fast-path tier
 * that outranks raw events at equal score. DB-only; frozen idempotent DDL that
 * degrades to a warning if the database is unreachable.
 */

import type { Migration, MigrationContext, MigrationResult } from './types.js';

const SCHEMA_VERSION_AT_0_10_0 = 4;

const V4_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS memory_facts (
     fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     cluster_key        TEXT NOT NULL,
     fact_text          TEXT NOT NULL,
     search_text        TEXT NOT NULL,
     source_event_ids   UUID[] NOT NULL,
     derived_through_ts TIMESTAMPTZ NOT NULL,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     status             TEXT NOT NULL DEFAULT 'active',
     superseded_by      UUID
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_active_cluster ON memory_facts (cluster_key) WHERE status = 'active';`,
  `CREATE INDEX IF NOT EXISTS idx_facts_trgm ON memory_facts USING GIN (search_text gin_trgm_ops);`,
];

const migration_0_9_0_to_0_10_0: Migration = {
  from: '0.9.0',
  to: '0.10.0',
  severity: 'minor',
  description: 'Add the curated hot tier (memory_facts, schema v4)',
  notes:
    'Creates memory_facts and its indexes, then stamps schema_version=4. DB-only ' +
    'and idempotent; an unreachable database degrades to a warning (run ' +
    '`memory-pkg schema` later). Facts are promoted by `consolidate --deep` from ' +
    'entity clusters whose memories are rated useful.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];

    if (ctx.dryRun) {
      // no DB writes on dry runs
    } else if (!ctx.runQuery) {
      warnings.push('database not configured; memory_facts not created. Run `memory-pkg schema` later.');
    } else {
      try {
        for (const sql of V4_DDL) await ctx.runQuery(sql);
        await ctx.runQuery(
          `INSERT INTO memory_meta (key, value, updated_at)
           VALUES ('schema_version', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
           WHERE memory_meta.value::int < $2`,
          [String(SCHEMA_VERSION_AT_0_10_0), SCHEMA_VERSION_AT_0_10_0],
        );
      } catch (err) {
        warnings.push(
          `database unreachable or DDL failed; memory_facts not applied ` +
            `(${err instanceof Error ? err.message : String(err)}). Run \`memory-pkg schema\` later.`,
        );
      }
    }

    return { managedFiles: ctx.state.managedFiles.map((f) => ({ ...f })), changedFiles: [], warnings };
  },
};

export default migration_0_9_0_to_0_10_0;
