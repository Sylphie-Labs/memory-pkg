/**
 * consolidate.runner.test.ts -- Orchestration contract for runConsolidation()
 * (Phase 1), exercised with injected fake processors so it needs no DB.
 *
 * Covers: the shared lock (mutual exclusion + release), cadence filtering
 * (tick vs deep), the time budget cutoff, and per-processor error isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runConsolidation } from '../src/consolidate/runner.js';
import type { Processor, ProcessorContext } from '../src/consolidate/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mpkg-consol-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fake(
  name: string,
  cadence: Processor['cadence'],
  opts: { throws?: boolean; sleepMs?: number } = {},
): { proc: Processor; calls: ProcessorContext[] } {
  const calls: ProcessorContext[] = [];
  const proc: Processor = {
    name,
    cadence,
    async run(ctx) {
      calls.push(ctx);
      if (opts.sleepMs) await delay(opts.sleepMs);
      if (opts.throws) throw new Error(`${name} boom`);
      return { processed: 1, skipped: 0, exhausted: true };
    },
  };
  return { proc, calls };
}

describe('runConsolidation orchestration', () => {
  it('skips when the lock is already held, and does not run processors', async () => {
    writeFileSync(path.join(dir, 'consolidate.lock'), JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
    const a = fake('a', 'both');
    const r = await runConsolidation({ bufferDir: dir, processors: [a.proc] });
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe('locked');
    expect(a.calls.length).toBe(0);
  });

  it('releases the lock after a run so a later run can proceed', async () => {
    const a = fake('a', 'both');
    await runConsolidation({ bufferDir: dir, processors: [a.proc] });
    expect(existsSync(path.join(dir, 'consolidate.lock'))).toBe(false);
    const r2 = await runConsolidation({ bufferDir: dir, processors: [a.proc] });
    expect(r2.ran).toBe(true);
    expect(a.calls.length).toBe(2);
  });

  it('on a tick, runs tick + both processors and skips deep-only', async () => {
    const tickP = fake('tick', 'tick');
    const deepP = fake('deep', 'deep');
    const bothP = fake('both', 'both');
    const r = await runConsolidation({
      bufferDir: dir,
      sessionId: 'S1',
      processors: [tickP.proc, deepP.proc, bothP.proc],
    });
    expect(r.ran).toBe(true);
    expect(tickP.calls.length).toBe(1);
    expect(bothP.calls.length).toBe(1);
    expect(deepP.calls.length).toBe(0);
    // tick passes the sessionId through.
    expect(tickP.calls[0].sessionId).toBe('S1');
    expect(tickP.calls[0].deep).toBe(false);
  });

  it('on a deep pass, runs deep + both processors and skips tick-only (no sessionId)', async () => {
    const tickP = fake('tick', 'tick');
    const deepP = fake('deep', 'deep');
    const bothP = fake('both', 'both');
    const r = await runConsolidation({
      deep: true,
      bufferDir: dir,
      sessionId: 'S1',
      processors: [tickP.proc, deepP.proc, bothP.proc],
    });
    expect(r.ran).toBe(true);
    expect(r.deep).toBe(true);
    expect(deepP.calls.length).toBe(1);
    expect(bothP.calls.length).toBe(1);
    expect(tickP.calls.length).toBe(0);
    // deep carries no session scope.
    expect(deepP.calls[0].sessionId).toBeUndefined();
    expect(deepP.calls[0].deep).toBe(true);
  });

  it('stops launching processors once the time budget is spent', async () => {
    const slow = fake('slow', 'both', { sleepMs: 60 });
    const after = fake('after', 'both');
    const r = await runConsolidation({
      bufferDir: dir,
      budgetMs: 30, // slow (60ms) overruns it, so `after` must not start
      processors: [slow.proc, after.proc],
    });
    expect(r.ran).toBe(true);
    expect(slow.calls.length).toBe(1);
    expect(after.calls.length).toBe(0);
  });

  it('isolates a throwing processor: later processors still run, result records it', async () => {
    const boom = fake('boom', 'both', { throws: true });
    const ok = fake('ok', 'both');
    const r = await runConsolidation({ bufferDir: dir, processors: [boom.proc, ok.proc] });
    expect(r.ran).toBe(true);
    expect(ok.calls.length).toBe(1);
    const boomResult = r.processors.find((p) => p.name === 'boom');
    expect(boomResult).toBeDefined();
    expect(boomResult!.processed).toBe(0);
  });
});
