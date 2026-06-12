/**
 * timescale-client.ts -- Postgres/TimescaleDB connection manager for memory-pkg.
 *
 * Singleton pg Pool. All memory queries flow through here.
 *
 * Connection settings are resolved by getDatabaseConfig() in config.ts:
 *   MEMORY_PKG_PG_HOST / PORT / USER / PASSWORD / DATABASE env vars win, then
 *   .memory-pkg/config.json `database` block, then built-in defaults
 *   (localhost:5432, user=memory-pkg, db=memory).
 *
 * This means a non-default port set in config.json once propagates to every
 * code path automatically — CLI, hooks, MCP server, doctor — without having
 * to be templated into hook command lines (where it's easy to forget).
 */

import pg from 'pg';
import { getDatabaseConfig } from './config.js';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (_pool === null) {
    const db = getDatabaseConfig();
    _pool = new Pool({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on('error', (err) => {
      process.stderr.write(`[memory-pkg] pool error: ${err.message}\n`);
    });

    // Lower the word_similarity threshold so the `<%` operator (used by the
    // trigram/entity tiers, and GIN-indexable via idx_memory_trgm) matches our
    // 0.2 retrieval floor instead of the strict 0.6 default. Queued on the
    // per-client query pipeline at connect time, so it lands before any tier
    // query on that connection. Best-effort: a failure just falls back to the
    // explicit `word_similarity(...) >= 0.2` recheck the tiers also carry.
    _pool.on('connect', (client) => {
      client.query('SET pg_trgm.word_similarity_threshold = 0.2').catch(() => {});
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool !== null) {
    await _pool.end();
    _pool = null;
  }
}

export async function runQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}
