/**
 * rateMemoryInjections.ts -- MCP tool: Claude rates the memories it was
 * injected this turn.
 *
 * Append-only into memory_ratings. Ratings are coerced to {-1, 0, +1}
 * (>0 → 1, <0 → -1, else 0). Idempotent on (injection_id, item_id, source) so
 * retries are safe. An unknown injection_id is accepted and stored anyway
 * (no FK, fail-open) — consolidation reconciles via reporting, not constraints.
 */

import { runQuery } from '../../timescale-client.js';

export interface RateMemoryInjectionsInput {
  injection_id: string;
  ratings: Array<{ event_id: string; rating: number; item_kind?: 'event' | 'fact' }>;
  session_id?: string;
}

function coerce(r: number): number {
  if (typeof r !== 'number' || Number.isNaN(r)) return 0;
  if (r > 0) return 1;
  if (r < 0) return -1;
  return 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleRateMemoryInjections(
  input: RateMemoryInjectionsInput,
): Promise<string> {
  const injectionId = String(input?.injection_id ?? '').trim();
  if (!UUID_RE.test(injectionId)) {
    return `rateMemoryInjections: injection_id must be a UUID (the "injection: <id>" line inside the <memory-context> block).`;
  }
  const ratings = Array.isArray(input?.ratings) ? input.ratings : [];
  if (ratings.length === 0) return `rateMemoryInjections: no ratings provided.`;

  let written = 0;
  let invalid = 0;
  for (const r of ratings) {
    const itemId = String(r?.event_id ?? '').trim();
    if (!UUID_RE.test(itemId)) {
      invalid++;
      continue;
    }
    const value = coerce(r.rating);
    const kind = r.item_kind === 'fact' ? 'fact' : 'event';
    await runQuery(
      `INSERT INTO memory_ratings (injection_id, item_id, item_kind, rating, source, session_id)
       VALUES ($1, $2, $3, $4, 'self', $5)
       ON CONFLICT (injection_id, item_id, source) DO NOTHING`,
      [injectionId, itemId, kind, value, input.session_id ?? null],
    );
    written++;
  }

  return `Recorded ${written} rating(s) for injection ${injectionId.slice(0, 8)}${invalid > 0 ? ` (${invalid} skipped: bad event_id)` : ''}. Thank you — this tunes future recall.`;
}
