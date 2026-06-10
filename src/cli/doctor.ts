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
import { getDatabaseConfig, getModelFor } from '../config.js';

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

async function checkRationaleWiring(cwd: string): Promise<CheckResult> {
  const candidates = [
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];

  let anyFileExists = false;
  const stopCommands: string[] = [];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    anyFileExists = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const stopGroups = (parsed?.hooks as Record<string, unknown> | undefined)?.Stop;
      if (!Array.isArray(stopGroups)) continue;
      for (const group of stopGroups) {
        const hookEntries = (group as Record<string, unknown>)?.hooks;
        if (!Array.isArray(hookEntries)) continue;
        for (const entry of hookEntries) {
          const cmd = (entry as Record<string, unknown>)?.command;
          if (typeof cmd === 'string') stopCommands.push(cmd);
        }
      }
    } catch {
      // unparseable file — skip silently
    }
  }

  if (!anyFileExists) {
    return {
      name: 'rationale wiring',
      status: 'warn',
      message: `no .claude/settings.json found; merge the snippet from 'memory-pkg init'`,
    };
  }
  if (stopCommands.length === 0) {
    return {
      name: 'rationale wiring',
      status: 'warn',
      message: `no Stop hook configured; capture/ingest/rationale won't run — re-merge the 'memory-pkg init' snippet`,
    };
  }
  if (!stopCommands.some((cmd) => cmd.includes('rationale'))) {
    return {
      name: 'rationale wiring',
      status: 'warn',
      message: `Stop hook runs but does not invoke rationale — automatic 'why' synthesis is off. Re-merge the updated snippet from 'memory-pkg init' (chains rationale after ingest).`,
    };
  }
  return {
    name: 'rationale wiring',
    status: 'pass',
    message: `Stop hook chains rationale synthesis`,
  };
}

async function checkInjectPath(_cwd: string): Promise<CheckResult> {
  // Exercise the same retrieval pipeline the UserPromptSubmit hook runs, so
  // a misconfigured port or unreachable DB surfaces here instead of only as
  // "Claude never seems to have past context." We call the tiers directly
  // (rather than generateInjection) so we can report per-tier outcomes —
  // generateInjection swallows errors into the merged set and returns ''.
  const { getFastPathTiers, getRescueTiers } = await import('../inject/tiers/index.js');
  const { readRecentInjectErrors } = await import('../inject/error-log.js');
  const tiers = [...getFastPathTiers(), ...getRescueTiers()];
  if (tiers.length === 0) {
    return { name: 'inject path', status: 'warn', message: 'no retrieval tiers enabled' };
  }
  const input = { query: 'memory-pkg doctor sample query', excludeSelf: false };
  const errors: string[] = [];
  const summary: string[] = [];
  for (const tier of tiers) {
    try {
      const r = await tier(input);
      if (r.error) errors.push(`${r.tier}: ${r.error.split('\n')[0]}`);
      else if (r.disabled) summary.push(`${r.tier}(off)`);
      else summary.push(`${r.tier}(${r.candidates.length})`);
    } catch (err) {
      errors.push(`tier crash: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  const recent = readRecentInjectErrors(3);
  const tail = recent.length > 0 ? `   (${recent.length} recent silent failures in inject-errors.log)` : '';
  if (errors.length > 0) {
    return { name: 'inject path', status: 'fail', message: errors.join('; ') + tail };
  }
  return { name: 'inject path', status: 'pass', message: summary.join(', ') + tail };
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

async function checkTimescale(cwd: string): Promise<CheckResult> {
  const db = getDatabaseConfig(cwd);
  try {
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      const r = await client.query('SELECT 1 AS ok');
      if (r.rows[0]?.ok === 1) {
        return { name: 'timescale', status: 'pass', message: `reachable at ${db.host}:${db.port}` };
      }
      return { name: 'timescale', status: 'warn', message: `connected but unexpected response` };
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch (err) {
    return {
      name: 'timescale',
      status: 'fail',
      message: `cannot reach ${db.host}:${db.port}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
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
    () => checkRationaleWiring(cwd),
    () => checkClaudeSpawnModels(cwd),
  ];
  if (!noNetwork) {
    checks.push(() => checkTimescale(cwd));
    checks.push(() => checkInjectPath(cwd));
  }

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
