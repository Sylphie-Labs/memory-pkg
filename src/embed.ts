/**
 * embed.ts -- Local text embedder for the memory-pkg embedding tier.
 *
 * Wraps @huggingface/transformers to produce 384-dim vectors from
 * `Xenova/bge-small-en-v1.5` (override via DRIFT_MEMORY_EMBED_MODEL). First call
 * in a process warm-loads the ONNX session (~1-2s); subsequent calls are ~30-80ms.
 *
 * Model weights are downloaded on first use (~90MB) and cached to disk by
 * the @huggingface/transformers library. Subsequent process launches load from cache.
 *
 * Cold-start cost in the UserPromptSubmit hook is the known tradeoff — accepted
 * per the tier plan. Migrate to a persistent daemon only if it becomes painful.
 */

import { runQuery } from './timescale-client.js';

const MODEL =
  process.env.MEMORY_PKG_EMBED_MODEL ||
  process.env.DRIFT_MEMORY_EMBED_MODEL ||
  'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = 384;
const MAX_EMBED_CHARS = 2000;

type Pipe = (text: string | string[], opts: Record<string, unknown>) => Promise<{
  data: Float32Array;
  dims: number[];
}>;

let _pipe: Promise<Pipe> | null = null;

/**
 * Deterministic, hash-based fake embedding for tests. Splits on whitespace,
 * maps each word to a bucket in [0, EMBED_DIM) via its summed char codes, sets
 * that bucket to 1/(words.length+1), then L2-normalizes. No model load.
 */
function fakeEmbedText(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  for (const word of words) {
    const bucket = word.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % EMBED_DIM;
    vec[bucket] = 1 / (words.length + 1);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

async function getPipeline(): Promise<Pipe> {
  if (process.env.MEMORY_PKG_EMBED_FAKE) {
    // Return a fake pipe that uses fakeEmbedText — no ONNX model load.
    return async (text, _opts) => {
      const texts = Array.isArray(text) ? text : [text];
      const vecs = texts.map(fakeEmbedText);
      const flat = new Float32Array(vecs.flat());
      return { data: flat, dims: [texts.length, EMBED_DIM] };
    };
  }
  if (_pipe === null) {
    _pipe = import('@huggingface/transformers').then(async (mod) => {
      const pipe = await mod.pipeline('feature-extraction', MODEL);
      return pipe as unknown as Pipe;
    });
  }
  return _pipe;
}

function truncate(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const out = await pipe(truncate(text), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const out = await pipe(texts.map(truncate), { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(Array.from(out.data.slice(i * dim, (i + 1) * dim)));
  }
  return result;
}

/** Convert a number[] to the pgvector text literal format: "[1.23,4.56,...]". */
export function toVectorLiteral(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

/**
 * Backfill embeddings for rows where `embedding IS NULL` in batches.
 * Picks embed source as excerpt ?? summary ?? search_text.
 */
export async function backfillEmbeddings(
  batchSize = 32,
  deadline?: number,
): Promise<{ updated: number }> {
  let updated = 0;

  while (true) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const rows = await runQuery<{
      event_id: string;
      ts: string;
      excerpt: string | null;
      search_text: string | null;
      summary: string | null;
    }>(
      `SELECT event_id, ts, excerpt, search_text, summary
       FROM memory_events
       WHERE embedding IS NULL
         AND (excerpt IS NOT NULL OR search_text IS NOT NULL OR summary IS NOT NULL)
       ORDER BY ts DESC
       LIMIT $1`,
      [batchSize],
    );
    if (rows.length === 0) break;

    const texts = rows.map((r) =>
      ((r.excerpt ?? r.summary ?? r.search_text) ?? '').trim(),
    );
    const vectors = await embedMany(texts);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const literal = toVectorLiteral(vectors[i]);
      await runQuery(
        `UPDATE memory_events SET embedding = $1::vector WHERE event_id = $2 AND ts = $3`,
        [literal, row.event_id, row.ts],
      );
      updated++;
    }
    process.stdout.write(`[backfill-embeddings] +${rows.length} (total ${updated})\n`);
  }

  return { updated };
}
