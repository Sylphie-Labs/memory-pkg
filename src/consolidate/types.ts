/**
 * consolidate/types.ts -- The processor contract for the "dream-state"
 * consolidation framework.
 *
 * Consolidation is where every *derived* write happens (rationales, entity
 * links, rating stats, fact promotion). The waking path (hooks + inject) only
 * reads the DB and appends raw rows; processors own everything else.
 *
 * Every processor must be:
 *   - idempotent      re-running is safe (anti-join queues, ON CONFLICT, etc.)
 *   - killable        check ctx.deadline between units of work, return early
 *   - resumable       the next run picks up where a killed one left off
 *
 * Cadence:
 *   - 'tick'  runs on the per-Stop tick (turn-grain; ctx.sessionId is set)
 *   - 'deep'  runs only on the periodic deep pass (corpus-grain; no sessionId)
 *   - 'both'  runs on either
 */

export interface ProcessorContext {
  /** Present on a tick (current session); absent on the deep pass. */
  sessionId?: string;
  /** Epoch ms budget ceiling — check between units of work and stop when past. */
  deadline: number;
  /** True on the deep pass. */
  deep: boolean;
  /** The resolved .claude/memory directory this run locks and operates on. */
  bufferDir: string;
  /** Append a human-readable line to .claude/memory/consolidate-log.jsonl. */
  log: (line: string) => void;
}

export interface ProcessorResult {
  /** Units of work successfully completed this run. */
  processed: number;
  /** Units intentionally skipped (already done, empty, not applicable). */
  skipped: number;
  /**
   * True when the processor drained its queue this run; false when it stopped
   * on the deadline with work remaining (the next run resumes it).
   */
  exhausted: boolean;
}

export interface Processor {
  name: string;
  cadence: 'tick' | 'deep' | 'both';
  run(ctx: ProcessorContext): Promise<ProcessorResult>;
}
