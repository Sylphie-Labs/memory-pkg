/**
 * rationale-backlog (deep) -- Drain unrationalized turns across ALL sessions,
 * not just the current one. The per-Stop tick caps at the current session;
 * this corpus-grain pass catches cross-session stragglers (e.g. turns from a
 * session whose Stop hook was killed before its rationale ran). Budget-aware
 * and resumable via the same anti-join queue.
 */

import { synthesizeRationales } from '../../rationale/synthesize.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const DEEP_RATIONALE_CAP = 20;

export const rationaleBacklogProcessor: Processor = {
  name: 'rationale-backlog',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const r = await synthesizeRationales({ limit: DEEP_RATIONALE_CAP, deadline: ctx.deadline });
    ctx.log(`rationale-backlog synthesized=${r.synthesized} skipped=${r.skipped}`);
    return {
      processed: r.synthesized,
      skipped: r.skipped,
      exhausted: r.synthesized + r.skipped < DEEP_RATIONALE_CAP,
    };
  },
};
