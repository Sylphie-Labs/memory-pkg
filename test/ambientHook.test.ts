/**
 * ambientHook.test.ts -- memory-ambient.cjs prefilter/dedup/cap behavior
 * (Phase 5), with a stub CLI so no DB is needed. The stub records every
 * invocation, letting us assert the hook only spawns on genuinely new entities.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const HOOK = path.resolve('template/.claude/hooks/memory-ambient.cjs');

let project: string;
let stubCli: string;
let invocationLog: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mpkg-amb-'));
  mkdirSync(path.join(project, '.claude', 'memory'), { recursive: true });
  invocationLog = path.join(project, 'invocations.log');
  // A stub "ambient" CLI: logs that it ran and returns an injecting block.
  stubCli = path.join(project, 'stub-cli.cjs');
  writeFileSync(
    stubCli,
    `const fs=require('fs');let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{` +
      `fs.appendFileSync(${JSON.stringify(invocationLog)}, b+'\\n');` +
      `process.stdout.write(JSON.stringify({text:'<ambient-memory>hit</ambient-memory>',injected:true}));` +
      `process.exit(0);});`,
    'utf8',
  );
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function runHook(toolInput: object, session = 's1'): { stdout: string } {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: session, tool_name: 'Grep', tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, MEMORY_PKG_CLI_PATH: stubCli },
  });
  return { stdout: res.stdout ?? '' };
}

function invocations(): number {
  if (!existsSync(invocationLog)) return 0;
  return readFileSync(invocationLog, 'utf8').split('\n').filter(Boolean).length;
}
function resetTurn(session = 's1'): void {
  appendFileSync(
    path.join(project, '.claude', 'memory', 'ambient', `${session}.jsonl`),
    JSON.stringify({ t: 'reset' }) + '\n',
  );
}

describe('memory-ambient.cjs', () => {
  it('spawns the CLI and injects on a genuinely new entity', () => {
    const { stdout } = runHook({ pattern: 'FilterBar' });
    expect(invocations()).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('ambient-memory');
  });

  it('does NOT spawn on a repeat of the same entity (dedup, the hot path)', () => {
    runHook({ pattern: 'FilterBar' });
    expect(invocations()).toBe(1);
    const { stdout } = runHook({ pattern: 'FilterBar' });
    expect(invocations()).toBe(1); // no new spawn
    expect(stdout).toBe(''); // no re-injection
  });

  it('emits nothing (no spawn) when the tool input has no entities', () => {
    const { stdout } = runHook({ pattern: 'just some words' });
    expect(invocations()).toBe(0);
    expect(stdout).toBe('');
  });

  it('enforces the per-turn cap of 2 injections', () => {
    runHook({ pattern: 'AlphaThing' });
    runHook({ pattern: 'BetaThing' });
    expect(invocations()).toBe(2);
    // Third distinct entity in the same turn — capped, no spawn.
    const { stdout } = runHook({ pattern: 'GammaThing' });
    expect(invocations()).toBe(2);
    expect(stdout).toBe('');
  });

  it('a new turn (reset marker) re-enables injection', () => {
    runHook({ pattern: 'AlphaThing' });
    runHook({ pattern: 'BetaThing' });
    expect(invocations()).toBe(2);
    resetTurn();
    runHook({ pattern: 'DeltaThing' });
    expect(invocations()).toBe(3);
  });

  it('respects MEMORY_PKG_AMBIENT_DISABLED', () => {
    const res = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: 's1', tool_name: 'Grep', tool_input: { pattern: 'FilterBar' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, MEMORY_PKG_CLI_PATH: stubCli, MEMORY_PKG_AMBIENT_DISABLED: '1' },
    });
    expect(res.stdout ?? '').toBe('');
    expect(invocations()).toBe(0);
  });
});
