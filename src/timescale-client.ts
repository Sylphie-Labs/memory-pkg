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
