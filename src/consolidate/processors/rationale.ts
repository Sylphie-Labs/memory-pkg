/**
 * rationale (tick) -- Synthesize "why" rationales for the current session's
 * unrationalized turns, capped low and budget-aware.
 *
 * The per-Stop tick only processes the current session (ctx.sessionId) with a
 * small cap so a turn never pays for a long backlog; the deep pass owns the
 * cross-session backlog drain (see rationale-backlog). The anti-join queue in
 * synthesizeRationales makes both idempotent and resumable.
 */

import { synthesizeRationales } from '../../rationale/synthesize.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const TICK_RATIONALE_CAP = 3;

export const rationaleProcessor: Processor = {
  name: 'rationale',
  cadence: 'tick',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const r = await synthesizeRationales({
      sessionId: ctx.sessionId,
      limit: TICK_RATIONALE_CAP,
      deadline: ctx.deadline,
    });
    ctx.log(`rationale synthesized=${r.synthesized} skipped=${r.skipped}`);
    return {
      processed: r.synthesized,
      skipped: r.skipped,
      exhausted: r.synthesized + r.skipped < TICK_RATIONALE_CAP,
    };
  },
};
