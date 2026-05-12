/**
 * rationale-log.ts -- Append per-prompt injection traces as JSONL for tuning.
 *
 * When DRIFT_MEMORY_LOG_PATH is set, generate.ts emits one line per prompt
 * capturing which tiers contributed, their latencies, the merged set, the
 * final picks, and rerank verdicts. The `memory tune` CLI reads this log to
 * aggregate per-tier effectiveness.
 *
 * Writing is best-effort — a logging failure never blocks injection.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TierTrace {
  latency_ms: number;
  candidate_count: number;
  disabled?: boolean;
  error?: string;
}

export interface FinalPick {
  event_id: string;
  score: number;
  source_tiers: string[];
  event_type: string;
  relevance: 0 | 1 | 2;
}

export interface InjectionTrace {
  ts: string;
  query: string;
  session_id: string | null;
  tiers: Record<string, TierTrace>;
  merged_count: number;
  final: FinalPick[];
  rerank_ran: boolean;
  rerank_dropped: number;
  /** True when fast path returned a strong match and rescue phase was skipped. */
  fastpath_strong?: boolean;
  total_latency_ms: number;
}

export function appendTrace(trace: InjectionTrace): void {
  const logPath = process.env.DRIFT_MEMORY_LOG_PATH;
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(trace) + '\n');
  } catch {
    // best-effort
  }
}

export interface TuneReport {
  total_prompts: number;
  per_tier: Record<string, {
    coverage: number;           // fraction of prompts where tier produced >=1 candidate
    unique_contribution: number; // fraction of FINAL picks surfaced only by this tier
    avg_latency_ms: number;
    error_rate: number;
    disabled_rate: number;
  }>;
  rerank: {
    runs: number;
    avg_dropped: number;
  };
  fastpath_strong_rate: number;  // fraction of prompts where rescue phase was skipped
  avg_total_latency_ms: number;
}

export function loadTraces(logPath: string): InjectionTrace[] {
  const raw = fs.readFileSync(logPath, 'utf8');
  const out: InjectionTrace[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as InjectionTrace);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function analyzeTraces(traces: InjectionTrace[]): TuneReport {
  const tierNames = new Set<string>();
  for (const t of traces) {
    for (const name of Object.keys(t.tiers)) tierNames.add(name);
  }

  const report: TuneReport = {
    total_prompts: traces.length,
    per_tier: {},
    rerank: { runs: 0, avg_dropped: 0 },
    fastpath_strong_rate: 0,
    avg_total_latency_ms: 0,
  };

  for (const tier of tierNames) {
    let coveragePrompts = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let errors = 0;
    let disabled = 0;
    let uniqueContribs = 0;
    let totalPicks = 0;

    for (const t of traces) {
      const info = t.tiers[tier];
      if (info) {
        if (info.disabled) disabled++;
        else {
          if (info.error) errors++;
          if (info.candidate_count > 0) coveragePrompts++;
          latencySum += info.latency_ms;
          latencyCount++;
        }
      }
      for (const pick of t.final) {
        totalPicks++;
        if (pick.source_tiers.length === 1 && pick.source_tiers[0] === tier) uniqueContribs++;
      }
    }

    report.per_tier[tier] = {
      coverage: traces.length > 0 ? coveragePrompts / traces.length : 0,
      unique_contribution: totalPicks > 0 ? uniqueContribs / totalPicks : 0,
      avg_latency_ms: latencyCount > 0 ? latencySum / latencyCount : 0,
      error_rate: traces.length > 0 ? errors / traces.length : 0,
      disabled_rate: traces.length > 0 ? disabled / traces.length : 0,
    };
  }

  let rerankRuns = 0;
  let totalLatency = 0;
  let totalDropped = 0;
  for (const t of traces) {
    if (t.rerank_ran) rerankRuns++;
    totalDropped += t.rerank_dropped;
    totalLatency += t.total_latency_ms;
  }

  report.rerank.runs = rerankRuns;
  report.rerank.avg_dropped = rerankRuns > 0 ? totalDropped / rerankRuns : 0;
  report.avg_total_latency_ms = traces.length > 0 ? totalLatency / traces.length : 0;

  // Fast-path short-circuit rate: fraction of prompts where rescue was skipped.
  const strongFast = traces.filter((t) => t.fastpath_strong === true).length;
  report.fastpath_strong_rate = traces.length > 0 ? strongFast / traces.length : 0;

  return report;
}

export function formatReport(report: TuneReport): string {
  const lines: string[] = [];
  lines.push(`Injection tuning report — ${report.total_prompts} prompts`);
  lines.push('');
  lines.push('Per-tier:');
  lines.push(
    '  tier         coverage  unique   avg_ms   err%   disabled%',
  );
  for (const [name, stats] of Object.entries(report.per_tier)) {
    lines.push(
      `  ${name.padEnd(11)} ${(stats.coverage * 100).toFixed(0).padStart(7)}%  ${(
        stats.unique_contribution * 100
      )
        .toFixed(0)
        .padStart(5)}%  ${stats.avg_latency_ms.toFixed(0).padStart(6)}  ${(stats.error_rate * 100)
        .toFixed(0)
        .padStart(4)}%   ${(stats.disabled_rate * 100).toFixed(0).padStart(7)}%`,
    );
  }
  lines.push('');
  lines.push(
    `Rerank: ran on ${report.rerank.runs}/${report.total_prompts} prompts, avg ${report.rerank.avg_dropped.toFixed(1)} candidates dropped per run.`,
  );
  lines.push(
    `Fast-path short-circuit: ${(report.fastpath_strong_rate * 100).toFixed(0)}% of prompts skipped the rescue phase.`,
  );
  lines.push(`Average total latency: ${report.avg_total_latency_ms.toFixed(0)} ms`);
  return lines.join('\n');
}
