/**
 * timescale-client.ts -- Postgres/TimescaleDB connection manager for memory-pkg.
 *
 * Singleton pg Pool. All memory queries flow through here.
 *
 * Environment overrides:
 *   MEMORY_PKG_PG_HOST     defaults to localhost
 *   MEMORY_PKG_PG_PORT     defaults to 5432
 *   MEMORY_PKG_PG_USER     defaults to memory-pkg
 *   MEMORY_PKG_PG_PASSWORD defaults to memory-pkg-local
 *   MEMORY_PKG_PG_DATABASE defaults to memory
 */

import pg from 'pg';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (_pool === null) {
    _pool = new Pool({
      host: process.env.MEMORY_PKG_PG_HOST ?? 'localhost',
      port: parseInt(process.env.MEMORY_PKG_PG_PORT ?? '5432', 10),
      user: process.env.MEMORY_PKG_PG_USER ?? 'memory-pkg',
      password: process.env.MEMORY_PKG_PG_PASSWORD ?? 'memory-pkg-local',
      database: process.env.MEMORY_PKG_PG_DATABASE ?? 'memory',
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
