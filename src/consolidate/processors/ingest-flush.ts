/**
 * ingest-flush -- Flush the local buffer.jsonl into TimescaleDB.
 *
 * Wraps the existing ingest() (which itself acquires ingest.lock and computes
 * embeddings for the new batch inside insertBatchReal). Runs on every cadence:
 * the tick flushes the current session's freshly-captured events, the deep
 * pass flushes anything an orphan sweep back-captured.
 */

import { ingest } from '../../ingest/ingester.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

export const ingestFlushProcessor: Processor = {
  name: 'ingest-flush',
  cadence: 'both',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const r = await ingest({ bufferDir: ctx.bufferDir });
    if (r.skipped === 'locked') {
      ctx.log('ingest-flush skipped: another ingest holds the lock');
      return { processed: 0, skipped: 1, exhausted: true };
    }
    ctx.log(`ingest-flush inserted=${r.inserted}`);
    return { processed: r.inserted, skipped: 0, exhausted: true };
  },
};
