/**
 * config.ts -- Per-repo user-facing config for memory-pkg.
 *
 * Lives at `.memory-pkg/config.json` alongside state.json. Where state.json is
 * machine-managed (install version, file hashes, paths), config.json is the
 * user's hand-editable surface for choices that affect billing — primarily
 * which model each `claude -p` spawn calls.
 *
 * Resolution precedence for any setting:
 *   1. Environment variable (highest)
 *   2. `.memory-pkg/config.json`
 *   3. Built-in default
 *
 * This lets CI override per-job without touching the file, while still giving
 * humans a discoverable surface for their everyday setup.
 */

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = '.memory-pkg';
const CONFIG_FILE = 'config.json';

export type SpawnKind = 'rationale' | 'rerank';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface ModelConfig {
  rationale?: string;
  rerank?: string;
}

export interface DatabaseConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export interface UserConfig {
  models?: ModelConfig;
  database?: DatabaseConfig;
}

const ENV_VAR_FOR_MODEL: Record<SpawnKind, string> = {
  rationale: 'MEMORY_PKG_RATIONALE_MODEL',
  rerank: 'MEMORY_PKG_RERANK_MODEL',
};

// Defaults for the local docker-compose / dev setup. Override per-project via
// .memory-pkg/config.json or MEMORY_PKG_PG_* env vars.
export const DEFAULT_DB_HOST = 'localhost';
export const DEFAULT_DB_PORT = 5432;
export const DEFAULT_DB_USER = 'memory-pkg';
export const DEFAULT_DB_PASSWORD = 'memory-pkg-local';
export const DEFAULT_DB_NAME = 'memory';

function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE);
}

let _cache: { cwd: string; mtimeMs: number; cfg: UserConfig } | null = null;

function loadConfig(cwd: string): UserConfig {
  const p = configPath(cwd);
  // Use the file's mtime as a cheap cache key so long-lived processes (the
  // MCP server) pick up edits to config.json without a restart. A missing
  // file is represented as mtime 0.
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    // File absent or unstattable — mtime stays 0.
  }
  if (_cache && _cache.cwd === cwd && _cache.mtimeMs === mtimeMs) return _cache.cfg;
  let cfg: UserConfig = {};
  if (mtimeMs > 0) {
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as UserConfig;
    } catch {
      // Malformed config; fall through to defaults. Don't crash the spawn path.
    }
  }
  _cache = { cwd, mtimeMs, cfg };
  return cfg;
}

/**
 * Pick the model for a given spawn. Env var wins; then config.json; then the
 * built-in default. `cwd` defaults to the consumer project (CLAUDE_PROJECT_DIR
 * when set by the hook, otherwise process.cwd()).
 */
export function getModelFor(kind: SpawnKind, cwd?: string): string {
  const fromEnv = process.env[ENV_VAR_FOR_MODEL[kind]];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const root = cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const cfg = loadConfig(root);
  const fromFile = cfg.models?.[kind];
  if (fromFile && fromFile.trim().length > 0) return fromFile;
  return DEFAULT_MODEL;
}

/**
 * Resolve the Postgres connection settings. Env vars (MEMORY_PKG_PG_*) win,
 * then `.memory-pkg/config.json` `database` block, then built-in defaults.
 *
 * Centralizing this here means every code path — CLI, hooks, MCP server,
 * doctor — gets the same view, so a non-default port set once in config.json
 * propagates everywhere without needing to be templated into hook commands.
 */
export function getDatabaseConfig(cwd?: string): Required<DatabaseConfig> {
  const root = cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const cfg = loadConfig(root).database ?? {};
  const portEnv = process.env.MEMORY_PKG_PG_PORT;
  const portFromEnv = portEnv ? parseInt(portEnv, 10) : NaN;
  return {
    host: process.env.MEMORY_PKG_PG_HOST ?? cfg.host ?? DEFAULT_DB_HOST,
    port: Number.isFinite(portFromEnv) ? portFromEnv : (cfg.port ?? DEFAULT_DB_PORT),
    user: process.env.MEMORY_PKG_PG_USER ?? cfg.user ?? DEFAULT_DB_USER,
    password: process.env.MEMORY_PKG_PG_PASSWORD ?? cfg.password ?? DEFAULT_DB_PASSWORD,
    database: process.env.MEMORY_PKG_PG_DATABASE ?? cfg.database ?? DEFAULT_DB_NAME,
  };
}

export function defaultUserConfig(): UserConfig {
  return {
    models: {
      rationale: DEFAULT_MODEL,
      rerank: DEFAULT_MODEL,
    },
    database: {
      host: DEFAULT_DB_HOST,
      port: DEFAULT_DB_PORT,
      user: DEFAULT_DB_USER,
      password: DEFAULT_DB_PASSWORD,
      database: DEFAULT_DB_NAME,
    },
  };
}

export function getConfigRelPath(): string {
  return path.join(CONFIG_DIR, CONFIG_FILE).replace(/\\/g, '/');
}

export const DEFAULT_SPAWN_MODEL = DEFAULT_MODEL;
