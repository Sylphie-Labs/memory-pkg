/**
 * orphanSweep.test.ts -- The B2 fix (Phase 2), tested without a DB.
 *
 * orphan-sweep only reads transcript JSONLs and writes buffer.jsonl + cursor
 * files, so it's exercised here purely on the filesystem. runConsolidation's
 * deep `setMeta('deep_last_ran_at')` fails soft when no DB is reachable, so the
 * sweep runs fine in a unit context.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runConsolidation } from '../src/consolidate/runner.js';
import { orphanSweepProcessor } from '../src/consolidate/processors/orphan-sweep.js';
import { withEnvAsync } from './helpers/db.js';
import { makeTranscript, userLine, assistantLine, userPrompt, assistantText } from './helpers/transcript.js';

let bufferDir: string;
let transcriptDir: string;

beforeEach(() => {
  bufferDir = mkdtempSync(path.join(tmpdir(), 'mpkg-sweep-buf-'));
  transcriptDir = mkdtempSync(path.join(tmpdir(), 'mpkg-sweep-tx-'));
});
afterEach(() => {
  rmSync(bufferDir, { recursive: true, force: true });
  rmSync(transcriptDir, { recursive: true, force: true });
});

function writeTranscript(sessionId: string, ageMs: number): string {
  const content = makeTranscript(sessionId, [
    userLine(userPrompt('the FilterBar date picker is broken')),
    assistantLine(assistantText('Looking at useDateRange and the reset handler.')),
  ]);
  const file = path.join(transcriptDir, `${sessionId}.jsonl`);
  writeFileSync(file, content, 'utf8');
  // Backdate mtime so the idle-gate treats it as not-live.
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(file, when, when);
  return file;
}

function bufferLines(): any[] {
  const p = path.join(bufferDir, 'buffer.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readCursor(sessionId: string): { byteOffset: number } | null {
  const p = path.join(bufferDir, 'cursors', `${sessionId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

const sweepEnv = () => ({ MEMORY_PKG_TRANSCRIPT_DIR: transcriptDir, CLAUDE_PROJECT_DIR: bufferDir });

describe('orphan-sweep (B2)', () => {
  it('back-captures a stranded transcript into the buffer and advances the cursor', async () => {
    const file = writeTranscript('sweepA', 30 * 60 * 1000); // 30 min idle
    await withEnvAsync(sweepEnv(), async () => {
      const r = await runConsolidation({ deep: true, bufferDir, processors: [orphanSweepProcessor] });
      expect(r.ran).toBe(true);
    });

    const events = bufferLines();
    expect(events.length).toBe(2);
    expect(events.map((e) => e.event_type).sort()).toEqual(['assistant_text', 'user_prompt']);
    // search_text / excerpt were derived (capture parity).
    expect(events.every((e) => typeof e.search_text === 'string')).toBe(true);

    const size = readFileSync(file, 'utf8').length;
    expect(readCursor('sweepA')?.byteOffset).toBe(size);
  });

  it('is idempotent: a second sweep appends nothing (cursor already at EOF)', async () => {
    writeTranscript('sweepB', 30 * 60 * 1000);
    await withEnvAsync(sweepEnv(), async () => {
      await runConsolidation({ deep: true, bufferDir, processors: [orphanSweepProcessor] });
      await runConsolidation({ deep: true, bufferDir, processors: [orphanSweepProcessor] });
    });
    expect(bufferLines().length).toBe(2);
  });

  it('skips a live (recently-modified) transcript', async () => {
    writeTranscript('sweepLive', 1000); // 1s idle — within the 10-min gate
    await withEnvAsync(sweepEnv(), async () => {
      await runConsolidation({ deep: true, bufferDir, processors: [orphanSweepProcessor] });
    });
    expect(bufferLines().length).toBe(0);
    expect(readCursor('sweepLive')).toBeNull();
  });

  it('honors the MEMORY_PKG_SWEEP_DISABLED kill switch', async () => {
    writeTranscript('sweepOff', 30 * 60 * 1000);
    await withEnvAsync({ ...sweepEnv(), MEMORY_PKG_SWEEP_DISABLED: '1' }, async () => {
      await runConsolidation({ deep: true, bufferDir, processors: [orphanSweepProcessor] });
    });
    expect(bufferLines().length).toBe(0);
  });
});
