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
const BUFFER_FILE = path.join(BUFFER_DIR, 'buffer.jsonl');
const PROCESSING_FILE = path.join(BUFFER_DIR, 'buffer.processing.jsonl');
const FAILED_FILE = path.join(BUFFER_DIR, 'buffer.failed.jsonl');

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

function rotateBuffer(): string | null {
  if (!fs.existsSync(BUFFER_FILE)) return null;

  // If a prior run crashed, merge old processing file back in.
  if (fs.existsSync(PROCESSING_FILE)) {
    const prev = fs.readFileSync(PROCESSING_FILE, 'utf8');
    fs.appendFileSync(PROCESSING_FILE, fs.readFileSync(BUFFER_FILE, 'utf8'));
    fs.unlinkSync(BUFFER_FILE);
    return PROCESSING_FILE;
  }

  fs.renameSync(BUFFER_FILE, PROCESSING_FILE);
  return PROCESSING_FILE;
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

async function insertBatch(events: BufferEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const embeddings = await computeEmbeddings(events);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const COLS = 14;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    events.forEach((e, i) => {
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
        embeddings[i],
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
    await client.query('COMMIT');
    return events.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function ingest(): Promise<{ inserted: number; failedFile?: string }> {
  const file = rotateBuffer();
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
    // Preserve the unprocessed batch for manual inspection.
    if (fs.existsSync(FAILED_FILE)) {
      fs.appendFileSync(FAILED_FILE, content);
      fs.unlinkSync(file);
    } else {
      fs.renameSync(file, FAILED_FILE);
    }
    throw err;
  }
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ingest()
    .then((r) => {
      process.stdout.write(`[ingester] inserted ${r.inserted} event(s)\n`);
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      process.stderr.write(`[ingester] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      closePool().finally(() => process.exit(1));
    });
}
