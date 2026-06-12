/**
 * schema.ts -- Idempotent schema initialization for memory-pkg.
 *
 * Creates the memory_events hypertable + indexes. Run via:
 *   pnpm --filter @drift/memory-pkg run schema:init
 * or
 *   pnpm memory:init   (from repo root)
 */

import { runQuery, closePool } from './timescale-client.js';

/**
 * Monotonically increasing schema version. Bump by 1 whenever a statement is
 * added to STATEMENTS below; initSchema stamps it into memory_meta after a
 * successful run. Version 1 = everything through 0.3.0 (memory_events
 * hypertable, subsystem, embedding, transcript_uuid unique index, memory_meta
 * itself).
 */
export const SCHEMA_VERSION = 3;

const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: 'extension: timescaledb',
    sql: `CREATE EXTENSION IF NOT EXISTS timescaledb;`,
  },
  {
    label: 'extension: pg_trgm',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm;`,
  },
  {
    label: 'extension: pgcrypto (gen_random_uuid)',
    sql: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
  },
  {
    label: 'extension: vector (pgvector)',
    sql: `CREATE EXTENSION IF NOT EXISTS vector;`,
  },
  {
    label: 'table: memory_events',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_events (
        event_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
        ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_id    TEXT        NOT NULL,
        project_path  TEXT,
        event_type    TEXT        NOT NULL,
        tool_name     TEXT,
        tool_use_id   TEXT,
        file_path     TEXT,
        summary       TEXT,
        excerpt       TEXT,
        search_text   TEXT,
        payload       JSONB,
        transcript_uuid TEXT,
        PRIMARY KEY (ts, event_id)
      );
    `,
  },
  {
    label: 'hypertable: memory_events',
    sql: `SELECT create_hypertable('memory_events', 'ts', if_not_exists => TRUE);`,
  },
  {
    label: 'index: session+ts',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_session_ts ON memory_events (session_id, ts DESC);`,
  },
  {
    label: 'index: event_id lookup',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_eventid ON memory_events (event_id);`,
  },
  {
    label: 'index: trigram fuzzy search',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_trgm ON memory_events USING GIN (search_text gin_trgm_ops);`,
  },
  {
    label: 'column: subsystem',
    sql: `ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS subsystem TEXT;`,
  },
  {
    label: 'index: subsystem+ts',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_subsystem ON memory_events (subsystem, ts DESC) WHERE subsystem IS NOT NULL;`,
  },
  {
    label: 'column: embedding (384-dim, bge-small)',
    sql: `ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS embedding vector(384);`,
  },
  {
    label: 'index: HNSW cosine over embedding',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw ON memory_events USING hnsw (embedding vector_cosine_ops);`,
  },
  {
    label: 'index: event_type+ts',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_events (event_type, ts DESC);`,
  },
  {
    label: 'index: file_path+ts',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_file ON memory_events (file_path, ts DESC) WHERE file_path IS NOT NULL;`,
  },
  {
    // TimescaleDB requires the partitioning column (ts) in unique indexes on hypertables.
    label: 'unique: transcript_uuid (idempotent ingest)',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_transcript_uuid ON memory_events (session_id, transcript_uuid, ts) WHERE transcript_uuid IS NOT NULL;`,
  },
  {
    label: 'table: memory_meta (schema versioning)',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },

  // --- Schema v2 (0.6.0): the entity graph ------------------------------------
  // Deterministic bipartite entity↔event index. Built by the entity-link
  // consolidation processor from extractEntities() — no LLM. Enables indexed
  // point-lookup retrieval (the structural B1 fix and the ambient hook's
  // surface) and one-hop entity → events → turn → rationale recall.
  {
    label: 'table: memory_entities',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_entities (
        entity_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name_norm    TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_count  INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    label: 'index: entities name_norm trigram',
    sql: `CREATE INDEX IF NOT EXISTS idx_entities_trgm ON memory_entities USING GIN (name_norm gin_trgm_ops);`,
  },
  {
    label: 'table: memory_entity_events (bipartite links)',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_entity_events (
        entity_id           UUID NOT NULL,
        event_id            UUID NOT NULL,
        event_ts            TIMESTAMPTZ NOT NULL,
        event_type          TEXT NOT NULL,
        session_id          TEXT NOT NULL,
        turn_user_prompt_id UUID,
        PRIMARY KEY (entity_id, event_id)
      );
    `,
  },
  {
    label: 'index: entity_events (entity_id, event_ts DESC)',
    sql: `CREATE INDEX IF NOT EXISTS idx_entity_events_entity_ts ON memory_entity_events (entity_id, event_ts DESC);`,
  },
  {
    label: 'index: entity_events (event_id)',
    sql: `CREATE INDEX IF NOT EXISTS idx_entity_events_event ON memory_entity_events (event_id);`,
  },
  {
    // entity → turn → rationale hop: rationale rows point at their turn's
    // user_prompt via payload->>'source_user_prompt_id'. Partial expression
    // index keeps that hop indexed (legal on a hypertable; not unique).
    label: 'index: rationale source_user_prompt_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_memory_rationale_source
            ON memory_events ((payload->>'source_user_prompt_id'))
            WHERE event_type = 'turn_rationale';`,
  },

  // --- Schema v3 (0.7.0): the feedback loop -----------------------------------
  // memory_injections records what was injected (so a rating can target the
  // right event rows). memory_ratings is append-only truth. memory_event_stats
  // is the derived aggregate consolidation maintains. None are hypertables and
  // none touch memory_events (which stays append-only).
  {
    label: 'table: memory_injections',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_injections (
        injection_id    UUID PRIMARY KEY,
        ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_id      TEXT,
        trigger         TEXT NOT NULL,
        query_or_entity TEXT,
        item_ids        UUID[] NOT NULL,
        item_kinds      TEXT[] NOT NULL,
        chars_injected  INTEGER NOT NULL DEFAULT 0,
        shadow_scores   JSONB
      );
    `,
  },
  {
    label: 'index: injections session+ts',
    sql: `CREATE INDEX IF NOT EXISTS idx_injections_session_ts ON memory_injections (session_id, ts DESC);`,
  },
  {
    label: 'table: memory_ratings (append-only)',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_ratings (
        rating_id    BIGSERIAL PRIMARY KEY,
        ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        injection_id UUID NOT NULL,
        item_id      UUID NOT NULL,
        item_kind    TEXT NOT NULL DEFAULT 'event',
        rating       SMALLINT NOT NULL CHECK (rating IN (-1, 0, 1)),
        source       TEXT NOT NULL DEFAULT 'self',
        referenced   BOOLEAN,
        session_id   TEXT
      );
    `,
  },
  {
    label: 'unique: ratings dedupe (injection_id, item_id, source)',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_dedupe ON memory_ratings (injection_id, item_id, source);`,
  },
  {
    label: 'index: ratings item',
    sql: `CREATE INDEX IF NOT EXISTS idx_ratings_item ON memory_ratings (item_id, ts DESC);`,
  },
  {
    label: 'table: memory_event_stats (derived aggregate)',
    sql: `
      CREATE TABLE IF NOT EXISTS memory_event_stats (
        item_id       UUID PRIMARY KEY,
        item_kind     TEXT NOT NULL DEFAULT 'event',
        n_self        INTEGER NOT NULL DEFAULT 0,
        sum_self      INTEGER NOT NULL DEFAULT 0,
        n_implicit    INTEGER NOT NULL DEFAULT 0,
        sum_implicit  INTEGER NOT NULL DEFAULT 0,
        last_rated_at TIMESTAMPTZ,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
];

export async function initSchema(): Promise<void> {
  for (const { label, sql } of STATEMENTS) {
    try {
      await runQuery(sql);
      process.stdout.write(`[schema] ok: ${label}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore "already exists" / "already a hypertable" style errors.
      if (/already exists|already a hypertable/i.test(msg)) {
        process.stdout.write(`[schema] skip (already present): ${label}\n`);
        continue;
      }
      if (/extension "vector" is not available|could not open extension control file.*vector/i.test(msg)) {
        process.stderr.write(
          `[schema] vector extension unavailable. Swap docker-compose image to ` +
          `timescale/timescaledb-ha:pg16 and restart the container:\n` +
          `  docker compose pull timescale && docker compose up -d timescale\n` +
          `then rerun this migration.\n`,
        );
        throw err;
      }
      process.stderr.write(`[schema] FAIL: ${label}\n  ${msg}\n`);
      throw err;
    }
  }
  await runQuery(
    `INSERT INTO memory_meta (key, value, updated_at)
     VALUES ('schema_version', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(SCHEMA_VERSION)],
  );
  process.stdout.write(`[schema] schema_version = ${SCHEMA_VERSION}\n`);
}

/**
 * Read the recorded schema version. Returns null when the memory_meta table
 * does not exist yet (database initialized by a pre-versioning release) or
 * the DB is unreachable — callers must treat null as "unknown", not "zero".
 */
export async function getSchemaVersion(): Promise<number | null> {
  try {
    const rows = await runQuery<{ value: string }>(
      `SELECT value FROM memory_meta WHERE key = 'schema_version'`,
    );
    if (rows.length === 0) return null;
    const n = parseInt(rows[0].value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initSchema()
    .then(() => closePool())
    .then(() => {
      process.stdout.write('[schema] done\n');
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(`[schema] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      closePool().finally(() => process.exit(1));
    });
}
