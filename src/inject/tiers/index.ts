/**
 * tiers/index.ts -- Registry of retrieval tiers.
 *
 * Each tier self-checks its DRIFT_MEMORY_TIER_<NAME>_DISABLED env var and
 * returns `{ disabled: true, candidates: [] }` when off — no registry-level
 * gating needed. Callers just Promise.all over getEnabledTiers() and let
 * the merger drop disabled/errored results.
 */

import type { Tier } from './types.js';
import { trigramTier } from './trigram.js';
import { entityTier } from './entity.js';
import { embeddingTier } from './embedding.js';

export * from './types.js';

// Fast path: cheap lexical tiers (trigram + entity) run in parallel on every
// prompt. Rescue: the semantic embedding tier runs only when the fast path is
// weak (see FASTPATH_STRONG_THRESHOLD in generate.ts), so the cold-start model
// load is paid rarely rather than on every prompt.

export function getFastPathTiers(): Tier[] {
  return [trigramTier, entityTier];
}

export function getRescueTiers(): Tier[] {
  return [embeddingTier];
}
