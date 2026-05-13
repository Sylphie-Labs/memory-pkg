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

export type SpawnKind = 'rationale' | 'classify' | 'rerank';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface ModelConfig {
  rationale?: string;
  classify?: string;
  rerank?: string;
}

export interface UserConfig {
  models?: ModelConfig;
}

const ENV_VAR_FOR_MODEL: Record<SpawnKind, string> = {
  rationale: 'MEMORY_PKG_RATIONALE_MODEL',
  classify: 'MEMORY_PKG_CLASSIFY_MODEL',
  rerank: 'MEMORY_PKG_RERANK_MODEL',
};

function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR, CONFIG_FILE);
}

let _cache: { cwd: string; cfg: UserConfig } | null = null;

function loadConfig(cwd: string): UserConfig {
  if (_cache && _cache.cwd === cwd) return _cache.cfg;
  const p = configPath(cwd);
  let cfg: UserConfig = {};
  if (fs.existsSync(p)) {
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as UserConfig;
    } catch {
      // Malformed config; fall through to defaults. Don't crash the spawn path.
    }
  }
  _cache = { cwd, cfg };
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

export function defaultUserConfig(): UserConfig {
  return {
    models: {
      rationale: DEFAULT_MODEL,
      classify: DEFAULT_MODEL,
      rerank: DEFAULT_MODEL,
    },
  };
}

export function getConfigRelPath(): string {
  return path.join(CONFIG_DIR, CONFIG_FILE).replace(/\\/g, '/');
}

export const DEFAULT_SPAWN_MODEL = DEFAULT_MODEL;
