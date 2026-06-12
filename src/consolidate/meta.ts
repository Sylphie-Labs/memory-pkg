/**
 * consolidate/meta.ts -- Tiny key/value accessors over the memory_meta table.
 *
 * memory_meta already exists (schema v1) and stores schema_version. The
 * consolidation framework reuses it for cross-run bookkeeping like
 * deep_last_ran_at (the staleness guard for the deep pass) and rating_mean
 * (the positive-skew normalizer, Phase 6). All reads fail soft (return null on
 * an unreachable DB) so callers can degrade gracefully.
 */

import { runQuery } from '../timescale-client.js';

export async function getMeta(key: string): Promise<string | null> {
  try {
    const rows = await runQuery<{ value: string }>(
      `SELECT value FROM memory_meta WHERE key = $1`,
      [key],
    );
    return rows.length > 0 ? rows[0].value : null;
  } catch {
    return null;
  }
}

export async function setMeta(key: string, value: string): Promise<void> {
  await runQuery(
    `INSERT INTO memory_meta (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}
