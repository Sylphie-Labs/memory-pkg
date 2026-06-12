/**
 * memoryRateHook.test.ts -- The memory-rate.cjs Stop hook (Phase 4), exercised
 * by spawning it with a stdin payload (zero-DB, pure ledger logic).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const HOOK = path.resolve('template/.claude/hooks/memory-rate.cjs');

let project: string;
let injectionsDir: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'mpkg-rate-'));
  injectionsDir = path.join(project, '.claude', 'memory', 'injections');
  mkdirSync(injectionsDir, { recursive: true });
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function writeLedger(session: string, entries: object[]): void {
  writeFileSync(
    path.join(injectionsDir, `${session}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

function runHook(payload: object, extraEnv: Record<string, string> = {}): { stdout: string } {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, MEMORY_PKG_RATE_SAMPLE: '1', ...extraEnv },
  });
  return { stdout: res.stdout ?? '' };
}

const entry = (id: string, over: Partial<{ trigger: string; items: any[] }> = {}) => ({
  injection_id: id,
  ts: '2026-05-01T00:00:00.000Z',
  trigger: over.trigger ?? 'prompt',
  items: over.items ?? [{ item_id: `${id}-evt`, item_kind: 'event', summary120: `summary for ${id}` }],
});

describe('memory-rate.cjs', () => {
  it('blocks with a rating request quoting the injection and items', () => {
    writeLedger('s1', [entry('aaaaaaaa-1111-1111-1111-111111111111')]);
    const { stdout } = runHook({ session_id: 's1' });
    const out = JSON.parse(stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('rateMemoryInjections');
    expect(out.reason).toContain('aaaaaaaa-1111-1111-1111-111111111111');
    expect(out.reason).toContain('summary for');
    // Marks the injection requested so it won't re-ask.
    expect(existsSync(path.join(injectionsDir, 's1.requested'))).toBe(true);
  });

  it('no-ops on the second run (already requested)', () => {
    writeLedger('s2', [entry('bbbbbbbb-2222-2222-2222-222222222222')]);
    expect(runHook({ session_id: 's2' }).stdout).not.toBe('');
    expect(runHook({ session_id: 's2' }).stdout).toBe('');
  });

  it('no-ops when stop_hook_active is set (loop guard)', () => {
    writeLedger('s3', [entry('cccccccc-3333-3333-3333-333333333333')]);
    expect(runHook({ session_id: 's3', stop_hook_active: true }).stdout).toBe('');
  });

  it('no-ops with no ledger (the common case)', () => {
    expect(runHook({ session_id: 'no-such-session' }).stdout).toBe('');
  });

  it('respects MEMORY_PKG_RATING_DISABLED', () => {
    writeLedger('s4', [entry('dddddddd-4444-4444-4444-444444444444')]);
    expect(runHook({ session_id: 's4' }, { MEMORY_PKG_RATING_DISABLED: '1' }).stdout).toBe('');
  });

  it('caps the number of injections requested per session at 8', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `eeeeeeee-0000-0000-0000-${String(i).padStart(12, '0')}`);
    writeLedger('s5', ids.map((id) => entry(id)));
    const { stdout } = runHook({ session_id: 's5' });
    const out = JSON.parse(stdout);
    const requestedInReason = ids.filter((id) => out.reason.includes(id)).length;
    expect(requestedInReason).toBeLessThanOrEqual(8);
    expect(requestedInReason).toBeGreaterThan(0);
  });
});
