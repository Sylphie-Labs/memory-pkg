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

async function getPipeline(): Promise<Pipe> {
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
export async function backfillEmbeddings(batchSize = 32): Promise<{ updated: number }> {
  let updated = 0;

  while (true) {
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
