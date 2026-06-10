/**
 * ingester.ts -- Read the local JSONL buffer and bulk-insert into TimescaleDB.
 *
 * Called by the Stop hook (async) or manually via `pnpm memory:ingest`.
 * Rotates the buffer atomically so new hook writes during ingest don't get lost.
 *
 * Buffer location: .claude/memory/buffer.jsonl
 * Rotation: renames to buffer.processing.jsonl before reading, deletes on success.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getPool, closePool } from '../timescale-client.js';
import { deriveSubsystem } from '../subsystem.js';
import { embedMany, toVectorLiteral } from '../embed.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const BUFFER_DIR = path.join(PROJECT_DIR, '.claude', 'memory');

export interface BufferEvent {
  ts: string;
  session_id: string;
  project_path?: string;
  event_type: string;
  tool_name?: string;
  tool_use_id?: string;
  file_path?: string;
  summary?: string;
  excerpt?: string;
  search_text?: string;
  payload?: unknown;
  transcript_uuid?: string;
}

const LOCK_STALE_MS = 10 * 60 * 1000; // a Stop-hook ingest should never take 10 min

/**
 * Single-flight lock so a manual `memory-pkg ingest` and the async Stop-hook
 * ingest can't rotate/read/delete the same files concurrently. O_EXCL create
 * is the atomic check-and-claim; a lock older than LOCK_STALE_MS is treated
 * as a crashed run and broken.
 */
export function acquireLock(bufDir: string): boolean {
  const lockFile = path.join(bufDir, 'ingest.lock');
  if (!fs.existsSync(bufDir)) fs.mkdirSync(bufDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs <= LOCK_STALE_MS) return false; // live lock — back off
        fs.unlinkSync(lockFile); // stale — break it and retry the create
      } catch {
        // Lock vanished between open and stat/unlink — loop and retry create.
      }
    }
  }
  return false;
}

export function releaseLock(bufDir: string): void {
  try {
    fs.unlinkSync(path.join(bufDir, 'ingest.lock'));
  } catch {
    // already gone — fine
  }
}

export function rotateBuffer(bufDir: string): string | null {
  const bufferFile = path.join(bufDir, 'buffer.jsonl');
  const processingFile = path.join(bufDir, 'buffer.processing.jsonl');
  const tmp = `${bufferFile}.rotating`;

  // Recover a temp file orphaned by a crash mid-merge.
  if (fs.existsSync(tmp)) {
    fs.appendFileSync(processingFile, fs.readFileSync(tmp, 'utf8'));
    fs.unlinkSync(tmp);
  }

  const hasBuffer = fs.existsSync(bufferFile);
  const hasProcessing = fs.existsSync(processingFile);

  if (!hasBuffer) return hasProcessing ? processingFile : null;

  if (hasProcessing) {
    // rename() atomically detaches bufferFile from its path; hook appends
    // after this instant create a fresh buffer file, so no line can be lost
    // (the old read-then-unlink scheme dropped appends that raced the read).
    fs.renameSync(bufferFile, tmp);
    fs.appendFileSync(processingFile, fs.readFileSync(tmp, 'utf8'));
    fs.unlinkSync(tmp);
    return processingFile;
  }

  fs.renameSync(bufferFile, processingFile);
  return processingFile;
}

function parseLines(content: string): BufferEvent[] {
  const events: BufferEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as BufferEvent);
    } catch {
      // skip malformed
    }
  }
  return events;
}

/**
 * Embed each event's text (excerpt ?? summary ?? search_text) so the
 * embedding tier can do semantic KNN. tool_result events are skipped
 * (the embedding tier filters them out anyway and they're noisy/large).
 * Returns a pgvector literal string per event, or null where we skip or
 * if embedding fails — a vector problem must never drop the event.
 *
 * `embedFn` is injectable so the skip/fallback logic can be unit-tested
 * without loading the (heavy) embedding model; it defaults to embedMany.
 */
export async function computeEmbeddings(
  events: BufferEvent[],
  embedFn: (texts: string[]) => Promise<number[][]> = embedMany,
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(events.length).fill(null);
  const idxs: number[] = [];
  const texts: string[] = [];
  events.forEach((e, i) => {
    if (e.event_type === 'tool_result') return;
    const t = ((e.excerpt ?? e.summary ?? e.search_text) ?? '').trim();
    if (!t) return;
    idxs.push(i);
    texts.push(t);
  });
  if (texts.length === 0) return out;
  try {
    const vecs = await embedFn(texts);
    for (let k = 0; k < idxs.length; k++) out[idxs[k]] = toVectorLiteral(vecs[k]);
  } catch (err) {
    process.stderr.write(
      `[ingester] embedding failed, inserting without vectors: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return out;
}

const COLS = 14;
// Postgres caps bind parameters at 65535 per statement. Stay well under it.
const MAX_EVENTS_PER_STATEMENT = Math.floor(60000 / COLS); // 4285

/**
 * Real DB insert. Swappable via setInsertBatchFn so the filesystem-level
 * rotate/lock/ingest flow can be unit-tested without a live TimescaleDB.
 */
async function insertBatchReal(events: BufferEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const embeddings = await computeEmbeddings(events);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (let start = 0; start < events.length; start += MAX_EVENTS_PER_STATEMENT) {
      const chunk = events.slice(start, start + MAX_EVENTS_PER_STATEMENT);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      chunk.forEach((e, i) => {
        const base = i * COLS;
        placeholders.push(
          `($${base + 1}::timestamptz, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}::jsonb, $${base + 12}, $${base + 13}, $${base + 14}::vector)`
        );
        values.push(
          e.ts,
          e.session_id,
          e.project_path ?? null,
          e.event_type,
          e.tool_name ?? null,
          e.tool_use_id ?? null,
          e.file_path ?? null,
          e.summary ?? null,
          e.excerpt ?? null,
          e.search_text ?? null,
          e.payload != null ? JSON.stringify(e.payload) : null,
          e.transcript_uuid ?? null,
          deriveSubsystem(e.file_path),
          embeddings[start + i],
        );
      });

      // Cursor tracking prevents most duplicates. On crash-recovery edge cases,
      // the (session_id, transcript_uuid) unique index silently de-dupes.
      const sql = `
        INSERT INTO memory_events
          (ts, session_id, project_path, event_type, tool_name, tool_use_id,
           file_path, summary, excerpt, search_text, payload, transcript_uuid, subsystem, embedding)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      await client.query(sql, values);
    }

    await client.query('COMMIT');
    return events.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Indirection so the ingest() filesystem flow (rotate, lock, success-delete,
// failure-dead-letter) can be exercised in unit tests with a stub insert that
// never touches Postgres. Production always uses insertBatchReal.
let insertBatch: (events: BufferEvent[]) => Promise<number> = insertBatchReal;

/** Test hook: override the DB insert. Returns a restore fn. */
export function setInsertBatchFn(
  fn: (events: BufferEvent[]) => Promise<number>,
): () => void {
  const prev = insertBatch;
  insertBatch = fn;
  return () => {
    insertBatch = prev;
  };
}

export interface IngestOptions {
  /** Re-queue the dead-letter file (buffer.failed.jsonl) before ingesting. */
  retryFailed?: boolean;
  /** Override the buffer directory (defaults to CLAUDE_PROJECT_DIR/.claude/memory). */
  bufferDir?: string;
}

export async function ingest(
  opts: IngestOptions = {},
): Promise<{ inserted: number; skipped?: 'locked' }> {
  const bufDir = opts.bufferDir ?? BUFFER_DIR;
  const bufFile = path.join(bufDir, 'buffer.jsonl');
  const failedFile = path.join(bufDir, 'buffer.failed.jsonl');
  const lockFile = path.join(bufDir, 'ingest.lock');

  if (!acquireLock(bufDir)) {
    process.stderr.write(`[ingester] another ingest holds ${lockFile}; skipping this run\n`);
    return { inserted: 0, skipped: 'locked' };
  }

  try {
    if (opts.retryFailed && fs.existsSync(failedFile)) {
      // Re-queue dead-lettered events through the normal pipeline. Rename
      // first so a crash mid-requeue can't duplicate them.
      const tmp = `${failedFile}.retrying`;
      fs.renameSync(failedFile, tmp);
      fs.appendFileSync(bufFile, fs.readFileSync(tmp, 'utf8'));
      fs.unlinkSync(tmp);
      process.stdout.write(`[ingester] re-queued dead-letter batch from buffer.failed.jsonl\n`);
    }

    const file = rotateBuffer(bufDir);
    if (!file) return { inserted: 0 };

    const content = fs.readFileSync(file, 'utf8');
    const events = parseLines(content);

    if (events.length === 0) {
      fs.unlinkSync(file);
      return { inserted: 0 };
    }

    try {
      const n = await insertBatch(events);
      fs.unlinkSync(file);
      return { inserted: n };
    } catch (err) {
      // Preserve the unprocessed batch for inspection / `ingest --retry-failed`.
      if (fs.existsSync(failedFile)) {
        fs.appendFileSync(failedFile, content);
        fs.unlinkSync(file);
      } else {
        fs.renameSync(file, failedFile);
      }
      throw err;
    }
  } finally {
    releaseLock(bufDir);
  }
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ingest({ retryFailed: process.argv.includes('--retry-failed') })
    .then((r) => {
      process.stdout.write(`[ingester] inserted ${r.inserted} event(s)${r.skipped === 'locked' ? ' (skipped: locked)' : ''}\n`);
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      process.stderr.write(`[ingester] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      closePool().finally(() => process.exit(1));
    });
}
