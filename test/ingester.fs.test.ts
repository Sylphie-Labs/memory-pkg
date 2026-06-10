import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  acquireLock,
  releaseLock,
  rotateBuffer,
  ingest,
  setInsertBatchFn,
  type BufferEvent,
} from '../src/ingest/ingester.js';

// File names ingester.ts uses inside the buffer dir. Kept as literals here so a
// rename in the source is caught by these tests rather than silently passing.
const BUFFER = 'buffer.jsonl';
const PROCESSING = 'buffer.processing.jsonl';
const FAILED = 'buffer.failed.jsonl';
const ROTATING = 'buffer.jsonl.rotating';
const LOCK = 'ingest.lock';

function makeEvent(over: Partial<BufferEvent> = {}): BufferEvent {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    session_id: 'S1',
    event_type: 'assistant_text',
    excerpt: 'hello world',
    ...over,
  };
}

function jsonl(...events: BufferEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

let dir: string;
const p = (name: string) => path.join(dir, name);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ingester-fs-'));
  // Default stub so no test accidentally hits a real DB; individual tests
  // override with their own restore handle as needed.
  setInsertBatchFn(async (events) => events.length);
});

afterEach(() => {
  // Restore default insert and clean temp dir.
  setInsertBatchFn(async (events) => events.length);
  rmSync(dir, { recursive: true, force: true });
});

describe('rotateBuffer', () => {
  it('buffer only -> renames to processing and returns its path', () => {
    writeFileSync(p(BUFFER), jsonl(makeEvent()));

    const out = rotateBuffer(dir);

    expect(out).toBe(p(PROCESSING));
    expect(existsSync(p(BUFFER))).toBe(false);
    expect(existsSync(p(PROCESSING))).toBe(true);
    expect(readFileSync(p(PROCESSING), 'utf8')).toContain('hello world');
  });

  it('processing only (no buffer) -> returns processing path for crash recovery', () => {
    writeFileSync(p(PROCESSING), jsonl(makeEvent()));

    const out = rotateBuffer(dir);

    expect(out).toBe(p(PROCESSING));
    expect(existsSync(p(PROCESSING))).toBe(true);
  });

  it('neither buffer nor processing -> returns null', () => {
    expect(rotateBuffer(dir)).toBeNull();
  });

  it('both buffer and processing -> merges buffer into processing and returns processing', () => {
    writeFileSync(p(PROCESSING), jsonl(makeEvent({ excerpt: 'already-processing' })));
    writeFileSync(p(BUFFER), jsonl(makeEvent({ excerpt: 'fresh-buffer' })));

    const out = rotateBuffer(dir);

    expect(out).toBe(p(PROCESSING));
    expect(existsSync(p(BUFFER))).toBe(false);
    expect(existsSync(p(ROTATING))).toBe(false);
    const merged = readFileSync(p(PROCESSING), 'utf8');
    expect(merged).toContain('already-processing');
    expect(merged).toContain('fresh-buffer');
  });

  it('orphaned .rotating temp on entry -> appended into processing and cleaned up', () => {
    writeFileSync(p(PROCESSING), jsonl(makeEvent({ excerpt: 'survivor' })));
    writeFileSync(p(ROTATING), jsonl(makeEvent({ excerpt: 'orphan-recovered' })));

    const out = rotateBuffer(dir);

    expect(out).toBe(p(PROCESSING));
    expect(existsSync(p(ROTATING))).toBe(false);
    const merged = readFileSync(p(PROCESSING), 'utf8');
    expect(merged).toContain('survivor');
    expect(merged).toContain('orphan-recovered');
  });
});

describe('acquireLock / releaseLock', () => {
  it('second acquire while first holds the lock returns false (no throw)', () => {
    expect(acquireLock(dir)).toBe(true);
    expect(() => {
      expect(acquireLock(dir)).toBe(false);
    }).not.toThrow();
    releaseLock(dir);
  });

  it('breaks a stale lock (mtime older than 10min) and returns true', () => {
    expect(acquireLock(dir)).toBe(true);
    // Backdate the lock file 11 minutes into the past.
    const past = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(p(LOCK), past, past);

    expect(acquireLock(dir)).toBe(true);
    releaseLock(dir);
  });

  it('releaseLock removes the lock file and double-release does not throw', () => {
    expect(acquireLock(dir)).toBe(true);
    expect(existsSync(p(LOCK))).toBe(true);

    releaseLock(dir);
    expect(existsSync(p(LOCK))).toBe(false);

    expect(() => releaseLock(dir)).not.toThrow();
  });
});

describe('ingest with bufferDir', () => {
  it('no buffer or processing file -> returns { inserted: 0 }', async () => {
    const restore = setInsertBatchFn(vi.fn(async () => 0));
    const result = await ingest({ bufferDir: dir });
    expect(result).toEqual({ inserted: 0 });
    restore();
  });

  it('buffer with 2 valid events, insertBatch returns 2 -> files gone, inserted 2', async () => {
    writeFileSync(
      p(BUFFER),
      jsonl(makeEvent({ session_id: 'A' }), makeEvent({ session_id: 'B' })),
    );
    const insert = vi.fn(async (events: BufferEvent[]) => events.length);
    const restore = setInsertBatchFn(insert);

    const result = await ingest({ bufferDir: dir });

    expect(result).toEqual({ inserted: 2 });
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0][0]).toHaveLength(2);
    expect(existsSync(p(BUFFER))).toBe(false);
    expect(existsSync(p(PROCESSING))).toBe(false);
    expect(existsSync(p(LOCK))).toBe(false);
    restore();
  });

  it('--retry-failed: failed file + working insert -> rows inserted, failed file gone', async () => {
    writeFileSync(p(FAILED), jsonl(makeEvent({ excerpt: 'dead-letter-1' })));
    const insert = vi.fn(async (events: BufferEvent[]) => events.length);
    const restore = setInsertBatchFn(insert);

    const result = await ingest({ bufferDir: dir, retryFailed: true });

    expect(result).toEqual({ inserted: 1 });
    expect(insert).toHaveBeenCalledOnce();
    expect(existsSync(p(FAILED))).toBe(false);
    expect(existsSync(p(BUFFER))).toBe(false);
    expect(existsSync(p(PROCESSING))).toBe(false);
    restore();
  });

  it('insert throws -> batch is dead-lettered to buffer.failed.jsonl and error propagates', async () => {
    writeFileSync(p(BUFFER), jsonl(makeEvent({ excerpt: 'will-fail' })));
    const restore = setInsertBatchFn(async () => {
      throw new Error('db down');
    });

    await expect(ingest({ bufferDir: dir })).rejects.toThrow('db down');
    expect(existsSync(p(FAILED))).toBe(true);
    expect(readFileSync(p(FAILED), 'utf8')).toContain('will-fail');
    // Lock is released even on failure.
    expect(existsSync(p(LOCK))).toBe(false);
    restore();
  });
});
