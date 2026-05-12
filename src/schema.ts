/**
 * schema.ts -- Idempotent schema initialization for memory-pkg.
 *
 * Creates the memory_events hypertable + indexes. Run via:
 *   pnpm --filter @drift/memory-pkg run schema:init
 * or
 *   pnpm memory:init   (from repo root)
 */

import { runQuery, closePool } from './timescale-client.js';

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
