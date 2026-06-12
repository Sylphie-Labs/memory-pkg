/**
 * embedding-backfill (deep) -- Compute embeddings for any rows that landed
 * without a vector (e.g. an ingest where the model cold-start failed, or rows
 * predating embedding-at-ingest). Budget-aware: backfillEmbeddings stops at the
 * deadline between batches and the next deep pass resumes.
 */

import { backfillEmbeddings } from '../../embed.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

export const embeddingBackfillProcessor: Processor = {
  name: 'embedding-backfill',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const r = await backfillEmbeddings(32, ctx.deadline);
    ctx.log(`embedding-backfill updated=${r.updated}`);
    // We can't cheaply know if more remain without another query; treat a
    // deadline-bounded run conservatively. The next deep pass drains the rest.
    return { processed: r.updated, skipped: 0, exhausted: Date.now() < ctx.deadline };
  },
};
