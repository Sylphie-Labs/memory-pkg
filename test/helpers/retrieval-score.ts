/**
 * retrieval-score.ts -- Score retrieval quality for a seeded corpus.
 *
 * Each RetrievalCase runs generateInjection() against a temp rationale-log path,
 * reads back the trace's FinalPick[], and derives recall / rank / MRR / distractor
 * metrics from which event_ids made the injected block and in what order.
 *
 * The caller owns DB env scoping (withEnvAsync from test/helpers/db.ts) and corpus
 * seeding (seedCorpus from test/helpers/corpus-seeder.ts); scoreCase only manages
 * the per-call DRIFT_MEMORY_LOG_PATH temp file and the generateInjection call.
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateInjection } from '../../src/inject/generate.js';
import { loadTraces } from '../../src/inject/rationale-log.js';

export interface RetrievalCase {
  query: string;
  /** event_ids that MUST appear in the injected block. */
  goldIds: string[];
  /** event_ids that must NOT appear before the first gold pick. */
  negativeIds?: string[];
  /** Expected tier that should surface the gold, e.g. 'trigram' | 'embedding' | 'entity'. */
  expectedTier?: string;
  /** Human-readable case name for error messages. */
  label?: string;
}

export interface CaseScore {
  label: string;
  /** Fraction of goldIds found anywhere in the final picks. */
  recall: number;
  /** 1-indexed rank of the first gold pick; null if no gold appears. */
  firstGoldRank: number | null;
  /** Mean reciprocal rank: 1 / firstGoldRank, or 0 when no gold appears. */
  mrr: number;
  /** Count of negativeIds appearing before the first gold pick. */
  distractorsBefore: number;
  /** Union of source_tiers across all final picks, in first-seen order. */
  tiersUsed: string[];
  /** How many picks were in the injected block. */
  finalCount: number;
}

/**
 * Run one RetrievalCase: set DRIFT_MEMORY_LOG_PATH to a temp file, call
 * generateInjection, read the most recent trace, compute and return a CaseScore.
 *
 * The caller is responsible for setting DB env (via withEnvAsync) before calling.
 */
export async function scoreCase(
  c: RetrievalCase,
  opts?: { sessionId?: string },
): Promise<CaseScore> {
  const label = c.label ?? c.query;
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-score-'));
  const logPath = join(dir, 'trace.jsonl');

  const savedLogPath = process.env.DRIFT_MEMORY_LOG_PATH;
  process.env.DRIFT_MEMORY_LOG_PATH = logPath;

  try {
    await generateInjection({
      query: c.query,
      currentSessionId: opts?.sessionId,
    });

    // The most recent trace entry is the one for this query. The temp log starts
    // empty, so under normal use there is exactly one line, but read the last to
    // be robust if generateInjection ever emitted more.
    const traces = existsSync(logPath) ? loadTraces(logPath) : [];
    const trace = traces.length > 0 ? traces[traces.length - 1] : undefined;
    const picks = trace?.final ?? [];

    const goldSet = new Set(c.goldIds);
    const negativeSet = new Set(c.negativeIds ?? []);

    // recall: fraction of distinct goldIds present anywhere in the picks.
    const pickedIds = new Set(picks.map((p) => p.event_id));
    const goldFound = c.goldIds.filter((id) => pickedIds.has(id)).length;
    const recall = c.goldIds.length > 0 ? goldFound / c.goldIds.length : 0;

    // firstGoldRank: 1-indexed position of the first gold pick.
    let firstGoldRank: number | null = null;
    for (let i = 0; i < picks.length; i++) {
      if (goldSet.has(picks[i].event_id)) {
        firstGoldRank = i + 1;
        break;
      }
    }

    const mrr = firstGoldRank !== null ? 1 / firstGoldRank : 0;

    // distractorsBefore: negatives appearing before the first gold. When no gold
    // is present, every negative in the block counts as "before" (there is no
    // gold to precede them, so they all rank ahead of the absent gold).
    const cutoff = firstGoldRank !== null ? firstGoldRank - 1 : picks.length;
    let distractorsBefore = 0;
    for (let i = 0; i < cutoff; i++) {
      if (negativeSet.has(picks[i].event_id)) distractorsBefore++;
    }

    // tiersUsed: union of source_tiers across all picks, first-seen order.
    const seen = new Set<string>();
    const tiersUsed: string[] = [];
    for (const pick of picks) {
      for (const tier of pick.source_tiers) {
        if (!seen.has(tier)) {
          seen.add(tier);
          tiersUsed.push(tier);
        }
      }
    }

    return {
      label,
      recall,
      firstGoldRank,
      mrr,
      distractorsBefore,
      tiersUsed,
      finalCount: picks.length,
    };
  } finally {
    if (savedLogPath === undefined) delete process.env.DRIFT_MEMORY_LOG_PATH;
    else process.env.DRIFT_MEMORY_LOG_PATH = savedLogPath;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/** Run multiple cases and return all scores, in input order. */
export async function scoreSuite(
  cases: RetrievalCase[],
  opts?: { sessionId?: string },
): Promise<CaseScore[]> {
  const scores: CaseScore[] = [];
  for (const c of cases) {
    scores.push(await scoreCase(c, opts));
  }
  return scores;
}
