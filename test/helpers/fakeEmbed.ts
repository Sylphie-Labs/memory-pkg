/**
 * fakeEmbed.ts -- Deterministic 384-dim embedder for integration tests.
 *
 * Avoids loading the heavy ONNX model (src/embed.ts). Each word of the text is
 * hashed into one of 384 buckets via the sum of its char codes; that bucket's
 * dimension is set to 1 / (wordCount + 1), then the vector is L2-normalized.
 *
 * Property: texts that share words land in shared buckets and so have non-zero
 * cosine similarity; texts with disjoint vocabularies are (near-)orthogonal.
 */

const DIM = 384;

export function fakeEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return vec;

  const value = 1.0 / (words.length + 1);
  for (const word of words) {
    let sum = 0;
    for (let i = 0; i < word.length; i++) sum += word.charCodeAt(i);
    const bucket = sum % DIM;
    vec[bucket] += value;
  }

  // L2-normalize so cosine similarity is just the dot product.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

export function fakeEmbedMany(texts: string[]): number[][] {
  return texts.map(fakeEmbed);
}

/**
 * An async embedder matching the embedFn signature used by computeEmbeddings in
 * src/ingest/ingester.ts: (texts: string[]) => Promise<number[][]>.
 */
export function getFakeEmbedFn(): (texts: string[]) => Promise<number[][]> {
  return async (texts: string[]) => fakeEmbedMany(texts);
}
