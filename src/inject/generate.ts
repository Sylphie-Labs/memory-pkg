/**
 * generate.ts -- Orchestrator for the UserPromptSubmit memory-injection hook.
 *
 * 1. Runs all enabled tiers (trigram, embedding, classifier, kg, ...) in parallel.
 * 2. Merges their candidate sets.
 * 3. Bulk-fetches full event rows for merged candidates.
 * 4. Splits strong vs ambiguous by fuzzy score; reranks ambiguous via Haiku.
 * 5. Formats a <memory-context> markdown block within char + count budgets.
 *
 * Tier orchestration is the only job here. Retrieval logic lives in tiers/.
 */

import { runQuery } from '../timescale-client.js';
import { rerankCandidates, type RerankInput } from './rerank.js';
import { getFastPathTiers, getRescueTiers } from './tiers/index.js';
import type { Candidate } from './tiers/types.js';
import { mergeCandidates, applyDiversity, loadMergerConfig, type MergedCandidate } from './merger.js';
import { appendTrace, type TierTrace, type FinalPick } from './rationale-log.js';
import type { TierResult } from './tiers/types.js';

// When fast-path candidates have at least one score at/above this threshold,
// the rescue phase (classifier + kg) is skipped. Embedding similarity is
// liberal — random text can score ~0.6 — so the default is 0.7 to ensure the
// fast-path answer is genuinely strong before we short-circuit the classifier.
// Override via DRIFT_MEMORY_FASTPATH_STRONG_THRESHOLD.
const FASTPATH_STRONG_THRESHOLD = parseFloat(
  process.env.DRIFT_MEMORY_FASTPATH_STRONG_THRESHOLD || '0.7',
);

const DEFAULT_LIMIT = 3;
const MAX_TOTAL_CHARS = 4000;
const STRONG_THRESHOLD = 0.6;
const RERANK_MIN = 0.2;

interface EventRow {
  event_id: string;
  ts: string;
  session_id: string;
  event_type: string;
  tool_name: string | null;
  file_path: string | null;
  excerpt: string | null;
  summary: string | null;
}

export interface GenerateInjectionOptions {
  query: string;
  currentSessionId?: string;
  limit?: number;
  excludeSelf?: boolean;
  // Absolute path to current session's JSONL transcript. Passed down to the
  // entity tier which tails the last N lines for entity extraction.
  transcriptPath?: string;
}

async function fetchEventsByIds(ids: string[]): Promise<Map<string, EventRow>> {
  if (ids.length === 0) return new Map();
  const sql = `
    SELECT event_id, ts, session_id, event_type, tool_name, file_path, excerpt, summary
    FROM memory_events
    WHERE event_id = ANY($1::uuid[])
  `;
  const rows = await runQuery<EventRow>(sql, [ids]);
  return new Map(rows.map((r) => [r.event_id, r]));
}

export async function generateInjection(opts: GenerateInjectionOptions): Promise<string> {
  const tStart = Date.now();
  const query = (opts.query || '').trim();
  if (!query) return '';
  // Short-prompt skip — configurable via DRIFT_MEMORY_MIN_PROMPT_CHARS (default 4).
  // Plan recommends 15 for production; kept at 4 so `memory inject <short>` CLI testing works.
  const minChars = Math.max(1, parseInt(process.env.DRIFT_MEMORY_MIN_PROMPT_CHARS || '4', 10));
  if (query.length < minChars) return '';

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 10);
  const excludeSelf = opts.excludeSelf !== false;

  const tierInput = {
    query,
    sessionId: opts.currentSessionId,
    excludeSelf,
    transcriptPath: opts.transcriptPath,
  };

  const safeRun = (tier: ReturnType<typeof getFastPathTiers>[number]): Promise<TierResult> =>
    tier(tierInput).catch((err): TierResult => ({
      tier: 'unknown',
      candidates: [] as Candidate[],
      latency_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    }));

  const mergerConfig = loadMergerConfig();

  // Fast path: cheap tiers (trigram + embedding) run in parallel.
  const fastResults = await Promise.all(getFastPathTiers().map(safeRun));

  // If fast path has a clearly strong match, skip the rescue phase — no
  // classifier Haiku cost, no graph expansion. Threshold applies to the
  // MERGED (weighted) score so multi-tier agreement can count too.
  const fastMerged = mergeCandidates(fastResults, mergerConfig);
  const fastPathIsStrong = fastMerged.some((c) => c.score >= FASTPATH_STRONG_THRESHOLD);

  let results: TierResult[] = fastResults;
  let rescueRan = false;
  if (!fastPathIsStrong) {
    rescueRan = true;
    const rescueResults: TierResult[] = [];
    for (const tier of getRescueTiers()) {
      rescueResults.push(await safeRun(tier));
    }
    results = [...fastResults, ...rescueResults];
  }

  const merged = mergeCandidates(results, mergerConfig);
  if (merged.length === 0) return '';

  const rows = await fetchEventsByIds(merged.map((c) => c.event_id));

  type Ranked = { candidate: MergedCandidate; row: EventRow; relevance: 0 | 1 | 2 };
  const strong: Ranked[] = [];
  const ambiguous: { candidate: MergedCandidate; row: EventRow }[] = [];

  for (const c of merged) {
    const row = rows.get(c.event_id);
    if (!row) continue;
    if (c.score >= STRONG_THRESHOLD) {
      strong.push({ candidate: c, row, relevance: 2 });
    } else if (c.score >= RERANK_MIN) {
      ambiguous.push({ candidate: c, row });
    }
  }

  const ranked: Ranked[] = [...strong];

  // Rerank is OFF by default. Classifier + merger already do semantic filtering,
  // and rerank adds 4-8s per run. Enable with DRIFT_MEMORY_RERANK_ENABLED=1 (or
  // DRIFT_MEMORY_RERANK_DISABLED="" to negate legacy off-switches).
  const rerankEnabled = !!process.env.DRIFT_MEMORY_RERANK_ENABLED
    && !process.env.DRIFT_MEMORY_RERANK_DISABLED;

  if (ambiguous.length > 0 && rerankEnabled) {
    // Cap candidates sent to rerank — one Haiku call rating many items scales
    // poorly and wastes budget. Take the highest-scoring N ambiguous entries.
    const maxRerank = Math.max(
      1,
      parseInt(process.env.DRIFT_MEMORY_RERANK_MAX_CANDIDATES || '6', 10),
    );
    const topAmbiguous = ambiguous
      .slice()
      .sort((a, b) => b.candidate.score - a.candidate.score)
      .slice(0, maxRerank);

    type Anchor = { candidate: MergedCandidate; row: EventRow };
    const input: (RerankInput & { anchor: Anchor })[] = topAmbiguous.map((a) => ({
      excerpt: (a.row.excerpt ?? a.row.summary ?? '').trim(),
      event_type: a.row.event_type,
      score: a.candidate.score,
      anchor: a,
    }));
    const reranked = await rerankCandidates(query, input);
    for (const { item, relevance } of reranked) {
      if (relevance === 0) continue;
      ranked.push({ candidate: item.anchor.candidate, row: item.anchor.row, relevance });
    }
  } else if (ambiguous.length > 0) {
    // Rerank disabled — pass ambiguous through with baseline relevance=1 so
    // their scores still compete in the final sort.
    for (const a of ambiguous) {
      ranked.push({ candidate: a.candidate, row: a.row, relevance: 1 });
    }
  }

  if (ranked.length === 0) return '';

  ranked.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return b.candidate.score - a.candidate.score;
  });

  // Per-type diversity cap (disabled by default — set DRIFT_MEMORY_DIVERSITY_PER_TYPE).
  const diversified = applyDiversity(
    ranked.map((r) => ({ ...r, event_type: r.row.event_type })),
    mergerConfig.diversityPerType,
  );

  const lines: string[] = [];
  lines.push('<memory-context>');
  lines.push(
    'Relevant past events surfaced by fuzzy-matching your message against long-term memory. ' +
    'These are from previous sessions, not the current conversation. Use them as reference, not as current state.',
  );
  lines.push('');

  // Entity tier metadata: surface which entities were queried/dropped and
  // where more matches exist, so the model can call searchMemory directly
  // without fumbling the tool signature.
  const entityResult = results.find((r) => r.tier === 'entity');
  const meta = entityResult?.metadata;
  if (meta && meta.queried && meta.queried.length > 0) {
    lines.push(`Queried: ${meta.queried.join(', ')}`);
    if (meta.dropped && meta.dropped.length > 0) {
      lines.push(`Dropped (${meta.dropped.length} over cap): ${meta.dropped.join(', ')}`);
    }
    if (meta.overflow && Object.keys(meta.overflow).length > 0) {
      const over = Object.entries(meta.overflow)
        .map(([e, n]) => `${e} (${n})`)
        .join(', ');
      lines.push(`More matches available for: ${over}`);
    }
    lines.push('To widen: mcp__memory-pkg__searchMemory({ query: "<entity>", limit: 10 })');
    lines.push('');
  }

  const tierTraces: Record<string, TierTrace> = {};
  for (const r of results) {
    tierTraces[r.tier] = {
      latency_ms: r.latency_ms,
      candidate_count: r.candidates.length,
      ...(r.disabled ? { disabled: true } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  let totalChars = 0;
  let included = 0;
  const finalPicks: FinalPick[] = [];

  for (const { candidate: c, row: r } of diversified) {
    if (included >= limit) break;
    const date = new Date(r.ts).toISOString().slice(0, 10);
    const score = Math.round(c.score * 100);
    const tool = r.tool_name ? ` · ${r.tool_name}` : '';
    const file = r.file_path ? ` · ${r.file_path}` : '';
    const tierAnnotation = c.source_tiers.length > 0 ? ` · [${c.source_tiers.join('+')}]` : '';
    const excerpt = (r.excerpt ?? r.summary ?? '').trim();
    if (!excerpt) continue;

    const block = [
      `### Match ${included + 1} — ${score}% · ${r.event_type}${tool}${file} · ${date}${tierAnnotation}`,
      `> ${excerpt.replace(/\n/g, '\n> ')}`,
      '',
    ].join('\n');

    if (totalChars + block.length > MAX_TOTAL_CHARS) break;
    lines.push(block);
    totalChars += block.length;
    included++;
    finalPicks.push({
      event_id: c.event_id,
      score: c.score,
      source_tiers: c.source_tiers,
      event_type: r.event_type,
      relevance: (diversified.find((d) => d.candidate.event_id === c.event_id)?.relevance ?? 1) as 0 | 1 | 2,
    });
  }

  lines.push('</memory-context>');

  const rerankRan = ambiguous.length > 0 && rerankEnabled;
  const rerankDropped = rerankRan ? ambiguous.length - (ranked.length - strong.length) : 0;

  appendTrace({
    ts: new Date().toISOString(),
    query,
    session_id: opts.currentSessionId ?? null,
    tiers: tierTraces,
    merged_count: merged.length,
    final: finalPicks,
    rerank_ran: rerankRan,
    rerank_dropped: rerankDropped,
    fastpath_strong: !rescueRan,
    total_latency_ms: Date.now() - tStart,
  });

  return lines.join('\n');
}
