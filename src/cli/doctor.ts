/**
 * doctor.ts -- `memory-pkg doctor` command.
 *
 * Runs structural checks against the consumer's install:
 *   - state.json present and parseable
 *   - CLI version matches state.version
 *   - All managed files present (drift not fail-causing; missing is)
 *   - .mcp.json contains the memory-pkg server stanza
 *   - memory-inject.cjs and memory-capture.cjs parse with `node --check`
 *   - TimescaleDB reachable (skippable with --no-network)
 *
 * Exits 0 when all checks pass or only warn; exits 1 on any fail.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { detectDrift, readState } from '../upgrade/state.js';
import { compareVersions } from '../upgrade/runner.js';
import { getModelFor } from '../config.js';

type CheckResult = { name: string; status: 'pass' | 'warn' | 'fail'; message: string };

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function statusGlyph(s: CheckResult['status']): string {
  return s === 'pass' ? '✓' : s === 'warn' ? '⚠' : '✗';
}

async function checkStateFile(cwd: string): Promise<CheckResult> {
  const state = readState(cwd);
  if (!state) {
    return {
      name: 'state.json',
      status: 'fail',
      message: `.memory-pkg/state.json missing. Run 'memory-pkg init' to set up.`,
    };
  }
  return {
    name: 'state.json',
    status: 'pass',
    message: `version ${state.version} installed ${state.installedAt} (${state.installMode})`,
  };
}

async function checkVersionMatch(cwd: string): Promise<CheckResult> {
  const state = readState(cwd);
  if (!state) return { name: 'version-match', status: 'warn', message: 'no state file; skipped' };
  const cli = readPackageVersion();
  if (state.version === cli) {
    return { name: 'version-match', status: 'pass', message: `state and CLI both at ${cli}` };
  }
  const cmp = compareVersions(state.version, cli);
  return {
    name: 'version-match',
    status: 'warn',
    message:
      cmp < 0
        ? `state ${state.version} < CLI ${cli}. Run 'memory-pkg upgrade --plan' to preview migrations.`
        : `state ${state.version} > CLI ${cli}. Upgrade your global install, or run 'init --force' against the current state.`,
  };
}

async function checkManagedFiles(cwd: string): Promise<CheckResult> {
  const state = readState(cwd);
  if (!state) return { name: 'managed-files', status: 'warn', message: 'no state file; skipped' };
  const missing: string[] = [];
  const modified: string[] = [];
  for (const f of state.managedFiles) {
    const d = detectDrift(cwd, f);
    if (d === 'missing') missing.push(f.path);
    else if (d === 'modified') modified.push(f.path);
  }
  if (missing.length === 0 && modified.length === 0) {
    return {
      name: 'managed-files',
      status: 'pass',
      message: `${state.managedFiles.length}/${state.managedFiles.length} files unchanged`,
    };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.length} missing`);
  if (modified.length > 0) parts.push(`${modified.length} modified`);
  return {
    name: 'managed-files',
    status: missing.length > 0 ? 'fail' : 'warn',
    message: `${parts.join(', ')}. Run 'memory-pkg status' for details.`,
  };
}

async function checkMcpStanza(cwd: string): Promise<CheckResult> {
  const mcpPath = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(mcpPath)) {
    return { name: 'mcp.json', status: 'fail', message: '.mcp.json missing' };
  }
  try {
    const j = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
    if (!j.mcpServers || !j.mcpServers['memory-pkg']) {
      return { name: 'mcp.json', status: 'fail', message: 'no memory-pkg server registered' };
    }
    return { name: 'mcp.json', status: 'pass', message: 'memory-pkg server registered' };
  } catch {
    return { name: 'mcp.json', status: 'fail', message: '.mcp.json is not valid JSON' };
  }
}

async function checkHookSyntax(cwd: string): Promise<CheckResult> {
  const hooks = [
    '.claude/hooks/memory-capture.cjs',
    '.claude/hooks/memory-inject.cjs',
  ];
  const failures: string[] = [];
  for (const rel of hooks) {
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) {
      failures.push(`${rel} (missing)`);
      continue;
    }
    const result = spawnSync(process.execPath, ['--check', abs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      failures.push(`${rel} (syntax error: ${(result.stderr || '').split('\n')[0]})`);
    }
  }
  if (failures.length === 0) {
    return { name: 'hooks', status: 'pass', message: 'both hooks parse cleanly' };
  }
  return { name: 'hooks', status: 'fail', message: failures.join('; ') };
}

async function checkClaudeSpawnModels(cwd: string): Promise<CheckResult> {
  const rationale = getModelFor('rationale', cwd);
  const classify = getModelFor('classify', cwd);
  const rerank = getModelFor('rerank', cwd);
  return {
    name: 'claude -p models',
    status: 'pass',
    message: `rationale=${rationale}  classify=${classify}  rerank=${rerank}`,
  };
}

async function checkTimescale(): Promise<CheckResult> {
  const host = process.env.MEMORY_PKG_PG_HOST ?? 'localhost';
  const port = parseInt(process.env.MEMORY_PKG_PG_PORT ?? '5432', 10);
  try {
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      host,
      port,
      user: process.env.MEMORY_PKG_PG_USER ?? 'memory-pkg',
      password: process.env.MEMORY_PKG_PG_PASSWORD ?? 'memory-pkg-local',
      database: process.env.MEMORY_PKG_PG_DATABASE ?? 'memory',
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      const r = await client.query('SELECT 1 AS ok');
      if (r.rows[0]?.ok === 1) {
        return { name: 'timescale', status: 'pass', message: `reachable at ${host}:${port}` };
      }
      return { name: 'timescale', status: 'warn', message: `connected but unexpected response` };
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch (err) {
    return {
      name: 'timescale',
      status: 'fail',
      message: `cannot reach ${host}:${port}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }
}

export async function runDoctor(args: string[]): Promise<number> {
  const noNetwork = args.includes('--no-network');
  const cwd = process.cwd();

  process.stdout.write(`memory-pkg doctor — running checks in ${cwd}\n\n`);

  const checks: Array<() => Promise<CheckResult>> = [
    () => checkStateFile(cwd),
    () => checkVersionMatch(cwd),
    () => checkManagedFiles(cwd),
    () => checkMcpStanza(cwd),
    () => checkHookSyntax(cwd),
    () => checkClaudeSpawnModels(cwd),
  ];
  if (!noNetwork) checks.push(() => checkTimescale());

  let fails = 0, warns = 0;
  for (const run of checks) {
    let result: CheckResult;
    try {
      result = await run();
    } catch (err) {
      result = { name: 'unknown', status: 'fail', message: err instanceof Error ? err.message : String(err) };
    }
    process.stdout.write(
      `  ${statusGlyph(result.status)} ${result.name.padEnd(18)} ${result.message}\n`,
    );
    if (result.status === 'fail') fails++;
    else if (result.status === 'warn') warns++;
  }

  process.stdout.write(`\n${fails} fail, ${warns} warn, ${checks.length - fails - warns} pass.\n`);
  return fails > 0 ? 1 : 0;
}
