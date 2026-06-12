/**
 * 0.5.1 → 0.6.0 -- The entity graph (schema v2).
 *
 * Adds the deterministic bipartite entity index:
 *   - memory_entities          (canonical entity, name_norm UNIQUE, trgm index)
 *   - memory_entity_events     (entity↔event links, denormalized for fast reads)
 *   - idx_memory_rationale_source  (partial expression index for the
 *                                   entity → turn → rationale hop)
 *
 * DB-only migration. The DDL below is a FROZEN copy of the schema-v2 statements
 * (a migration is a historical artifact and must not chase src/schema.ts). It
 * is idempotent (IF NOT EXISTS) and degrades to a warning if the database is
 * unreachable — `memory-pkg schema` applies it later. The entity-link processor
 * (run by `consolidate --deep`, wired to SessionStart) backfills links from
 * existing event history afterward.
 */

import type { Migration, MigrationContext, MigrationResult } from './types.js';

const SCHEMA_VERSION_AT_0_6_0 = 2;

const V2_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS memory_entities (
     entity_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name_norm    TEXT NOT NULL UNIQUE,
     display_name TEXT NOT NULL,
     first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     event_count  INTEGER NOT NULL DEFAULT 0
   );`,
  `CREATE INDEX IF NOT EXISTS idx_entities_trgm ON memory_entities USING GIN (name_norm gin_trgm_ops);`,
  `CREATE TABLE IF NOT EXISTS memory_entity_events (
     entity_id           UUID NOT NULL,
     event_id            UUID NOT NULL,
     event_ts            TIMESTAMPTZ NOT NULL,
     event_type          TEXT NOT NULL,
     session_id          TEXT NOT NULL,
     turn_user_prompt_id UUID,
     PRIMARY KEY (entity_id, event_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_entity_events_entity_ts ON memory_entity_events (entity_id, event_ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_entity_events_event ON memory_entity_events (event_id);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_rationale_source
     ON memory_events ((payload->>'source_user_prompt_id'))
     WHERE event_type = 'turn_rationale';`,
];

const migration_0_5_1_to_0_6_0: Migration = {
  from: '0.5.1',
  to: '0.6.0',
  severity: 'minor',
  description: 'Add the entity graph (memory_entities + memory_entity_events, schema v2)',
  notes:
    'Creates the deterministic bipartite entity index and the rationale-source ' +
    'expression index, then stamps schema_version=2. DB-only and idempotent; an ' +
    'unreachable database degrades to a warning (run `memory-pkg schema` later). ' +
    'Run `consolidate --deep` (or just start a session — the SessionStart hook ' +
    'does) to backfill entity links from existing history.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];

    if (ctx.dryRun) {
      // No DB writes on dry runs.
    } else if (!ctx.runQuery) {
      warnings.push(
        'database not configured; entity-graph tables not created. ' +
          'Run `memory-pkg schema` once the database is reachable.',
      );
    } else {
      try {
        for (const sql of V2_DDL) await ctx.runQuery(sql);
        await ctx.runQuery(
          `INSERT INTO memory_meta (key, value, updated_at)
           VALUES ('schema_version', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
           WHERE memory_meta.value::int < $2`,
          [String(SCHEMA_VERSION_AT_0_6_0), SCHEMA_VERSION_AT_0_6_0],
        );
      } catch (err) {
        warnings.push(
          `database unreachable or DDL failed; entity-graph schema not applied ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `Run \`memory-pkg schema\` once the database is reachable.`,
        );
      }
    }

    return {
      managedFiles: ctx.state.managedFiles.map((f) => ({ ...f })),
      changedFiles: [],
      warnings,
    };
  },
};

export default migration_0_5_1_to_0_6_0;
