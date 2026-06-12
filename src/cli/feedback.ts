/**
 * feedback.ts -- `memory-pkg feedback` : the Phase 6 gate report.
 *
 * Prints the rating distribution, how many injections have been rated, how many
 * days of shadow data exist, and the shadow flip-rate (the fraction of
 * injections whose included items the usefulness multiplier would reorder —
 * computed entirely from memory_injections.shadow_scores). Then a GO/NO-GO
 * against the D9 gate for flipping MEMORY_PKG_USEFULNESS_LIVE on.
 */

import { runQuery } from '../timescale-client.js';

const GATE_MIN_RATED = 200;
const GATE_MIN_DAYS = 14;
const GATE_FLIP_LO = 0.05;
const GATE_FLIP_HI = 0.4;

interface ShadowEntry {
  merged: number;
  multiplier: number;
  effective: number;
}

function flips(scores: Record<string, ShadowEntry>): boolean {
  const ids = Object.keys(scores);
  if (ids.length < 2) return false;
  const byMerged = [...ids].sort((a, b) => scores[b].merged - scores[a].merged).join(',');
  const byEffective = [...ids].sort((a, b) => scores[b].effective - scores[a].effective).join(',');
  return byMerged !== byEffective;
}

export async function runFeedback(): Promise<void> {
  const out = process.stdout;

  const dist = await runQuery<{ source: string; rating: number; n: number }>(
    `SELECT source, rating, count(*)::int AS n FROM memory_ratings GROUP BY source, rating ORDER BY source, rating`,
  );
  const ratedInjections = await runQuery<{ n: number }>(
    `SELECT count(DISTINCT injection_id)::int AS n FROM memory_ratings`,
  );
  const span = await runQuery<{ days: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (max(ts) - min(ts))) / 86400.0 AS days FROM memory_injections`,
  );
  const shadow = await runQuery<{ shadow_scores: Record<string, ShadowEntry> | null }>(
    `SELECT shadow_scores FROM memory_injections WHERE shadow_scores IS NOT NULL`,
  );

  const nRated = ratedInjections[0]?.n ?? 0;
  const days = span[0]?.days ? Number(span[0].days) : 0;
  const flippable = shadow.filter((s) => s.shadow_scores && Object.keys(s.shadow_scores).length >= 2);
  const flipped = flippable.filter((s) => flips(s.shadow_scores!)).length;
  const flipRate = flippable.length > 0 ? flipped / flippable.length : 0;

  out.write(`memory-pkg feedback\n===================\n\n`);
  out.write(`Rating distribution:\n`);
  if (dist.length === 0) out.write(`  (no ratings yet)\n`);
  for (const d of dist) out.write(`  ${d.source.padEnd(9)} rating=${String(d.rating).padStart(2)}  n=${d.n}\n`);
  out.write(`\nRated injections: ${nRated}\n`);
  out.write(`Shadow data span: ${days.toFixed(1)} days\n`);
  out.write(`Shadow flip-rate: ${(flipRate * 100).toFixed(1)}% (${flipped}/${flippable.length} multi-item injections reorder)\n\n`);

  const passRated = nRated >= GATE_MIN_RATED;
  const passDays = days >= GATE_MIN_DAYS;
  const passFlip = flipRate >= GATE_FLIP_LO && flipRate <= GATE_FLIP_HI;
  const go = passRated && passDays && passFlip;

  out.write(`Gate (flip MEMORY_PKG_USEFULNESS_LIVE on):\n`);
  out.write(`  [${passRated ? 'x' : ' '}] ≥${GATE_MIN_RATED} rated injections        (${nRated})\n`);
  out.write(`  [${passDays ? 'x' : ' '}] ≥${GATE_MIN_DAYS} days of shadow data        (${days.toFixed(1)})\n`);
  out.write(`  [${passFlip ? 'x' : ' '}] flip-rate in ${GATE_FLIP_LO * 100}–${GATE_FLIP_HI * 100}%             (${(flipRate * 100).toFixed(1)}%)\n`);
  out.write(`\n${go ? 'GO' : 'NO-GO'} — ${go ? 'gate passed; spot-check 20 flips, then set MEMORY_PKG_USEFULNESS_LIVE=1.' : 'keep collecting shadow data.'}\n`);
}
