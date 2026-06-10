/**
 * db.ts -- Integration-test Postgres lifecycle helpers.
 *
 * createTestDb() provisions a throwaway database (memory_test_<rand>), runs the
 * real initSchema() against it, and returns a handle whose `env` points the
 * MEMORY_PKG_PG_* vars at it. seedEvents() does direct multi-row INSERTs that
 * bypass the ingest pipeline. withEnv/withEnvAsync scope env mutations.
 *
 * initSchema() (src/schema.ts) talks to the singleton pool in
 * src/timescale-client.ts, which resolves its connection from MEMORY_PKG_PG_*
 * the first time getPool() is called. We therefore set those vars, reset the
 * pool with closePool(), run the schema, then close again so later tests get a
 * fresh pool resolved against whatever env is current.
 */

import pg from 'pg';
import { randomBytes } from 'crypto';
import { initSchema } from '../../src/schema.js';
import { closePool } from '../../src/timescale-client.js';
import {
  DEFAULT_DB_HOST,
  DEFAULT_DB_PORT,
  DEFAULT_DB_USER,
  DEFAULT_DB_PASSWORD,
} from '../../src/config.js';

const { Client } = pg;

interface AdminConn {
  host: string;
  port: number;
  user: string;
  password: string;
}

function adminConn(): AdminConn {
  const portEnv = process.env.MEMORY_PKG_PG_PORT;
  const port = portEnv ? parseInt(portEnv, 10) : NaN;
  return {
    host: process.env.MEMORY_PKG_PG_HOST ?? DEFAULT_DB_HOST,
    port: Number.isFinite(port) ? port : DEFAULT_DB_PORT,
    user: process.env.MEMORY_PKG_PG_USER ?? DEFAULT_DB_USER,
    password: process.env.MEMORY_PKG_PG_PASSWORD ?? DEFAULT_DB_PASSWORD,
  };
}

function testEnvFor(name: string, admin: AdminConn): Record<string, string> {
  return {
    MEMORY_PKG_PG_HOST: admin.host,
    MEMORY_PKG_PG_PORT: String(admin.port),
    MEMORY_PKG_PG_USER: admin.user,
    MEMORY_PKG_PG_PASSWORD: admin.password,
    MEMORY_PKG_PG_DATABASE: name,
  };
}

export interface TestDb {
  name: string;
  /** MEMORY_PKG_PG_* vars pointing at the throwaway database. */
  env: Record<string, string>;
  drop(): Promise<void>;
}

/**
 * Create a throwaway database memory_test_<6-random-chars>, run initSchema()
 * against it, and return a handle. The admin connection (from MEMORY_PKG_PG_*
 * env or built-in dev defaults) connects to the `postgres` database to issue
 * CREATE/DROP DATABASE.
 */
export async function createTestDb(): Promise<TestDb> {
  const admin = adminConn();
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  const name = `memory_test_${suffix}`;

  const adminClient = new Client({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database: 'postgres',
  });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${name}"`);
  } finally {
    await adminClient.end();
  }

  const env = testEnvFor(name, admin);

  // Run the real schema against the new DB. The singleton pool resolves env on
  // first getPool(), so reset it before and after we borrow the env.
  await withEnvAsync(env, async () => {
    await closePool();
    try {
      await initSchema();
    } finally {
      await closePool();
    }
  });

  return {
    name,
    env,
    async drop() {
      await closePool();
      const c = new Client({
        host: admin.host,
        port: admin.port,
        user: admin.user,
        password: admin.password,
        database: 'postgres',
      });
      await c.connect();
      try {
        // Terminate stragglers so DROP DATABASE doesn't fail with "in use".
        await c.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
        await c.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await c.end();
      }
    },
  };
}

const REQUIRED_COLS = [
  'ts',
  'session_id',
  'event_type',
  'search_text',
  'excerpt',
  'summary',
  'transcript_uuid',
] as const;

/**
 * Direct-INSERT seeding that bypasses the ingest pipeline. Each row may omit any
 * field; defaults below fill the required columns. The set of columns inserted
 * is the union of the seven required columns plus any extra keys present on any
 * row (NULL where a given row lacks an extra column). Connects with a fresh pg
 * Client built from the supplied MEMORY_PKG_PG_* env.
 */
export async function seedEvents(
  env: Record<string, string>,
  rows: Partial<Record<string, unknown>>[],
): Promise<void> {
  if (rows.length === 0) return;

  // Column order: required columns first (ts uses NOW() default when absent),
  // then any extra columns referenced by at least one row.
  const extra: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!(REQUIRED_COLS as readonly string[]).includes(key) && !extra.includes(key)) {
        extra.push(key);
      }
    }
  }
  const cols = [...REQUIRED_COLS, ...extra];

  const values: unknown[] = [];
  const rowPlaceholders: string[] = [];
  let p = 1;
  for (const row of rows) {
    const cells: string[] = [];
    for (const col of cols) {
      if (col === 'ts' && row.ts === undefined) {
        cells.push('NOW()');
        continue;
      }
      cells.push(`$${p++}`);
      values.push(cellValue(col, row));
    }
    rowPlaceholders.push(`(${cells.join(', ')})`);
  }

  const sql =
    `INSERT INTO memory_events (${cols.join(', ')}) VALUES ` +
    rowPlaceholders.join(', ');

  const client = new Client({
    host: env.MEMORY_PKG_PG_HOST,
    port: parseInt(env.MEMORY_PKG_PG_PORT, 10),
    user: env.MEMORY_PKG_PG_USER,
    password: env.MEMORY_PKG_PG_PASSWORD,
    database: env.MEMORY_PKG_PG_DATABASE,
  });
  await client.connect();
  try {
    await client.query(sql, values);
  } finally {
    await client.end();
  }
}

function cellValue(col: string, row: Partial<Record<string, unknown>>): unknown {
  if (row[col] !== undefined) return row[col];
  switch (col) {
    case 'session_id':
      return 'test-session';
    case 'event_type':
      return 'assistant_text';
    case 'search_text':
      return '';
    case 'excerpt':
      return '';
    case 'summary':
      return '';
    default:
      // transcript_uuid and any unspecified optional column default to NULL.
      return null;
  }
}

/** Run fn() with process.env augmented by vars; restore env afterward. */
export function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = snapshot(vars);
  apply(vars);
  try {
    return fn();
  } finally {
    restore(saved);
  }
}

/** Async variant of withEnv: restores env even if the promise rejects. */
export async function withEnvAsync<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = snapshot(vars);
  apply(vars);
  try {
    return await fn();
  } finally {
    restore(saved);
  }
}

function snapshot(vars: Record<string, string>): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  return saved;
}

function apply(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
}

function restore(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
