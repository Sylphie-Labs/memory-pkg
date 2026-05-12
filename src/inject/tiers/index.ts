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
import { classifierTier } from './classifier.js';
import { kgTier } from './kg.js';

export * from './types.js';

// Trigram + entity pipeline. Embedding/classifier/kg tiers remain imported
// but dormant — flip them back into the arrays below to re-enable.
void embeddingTier;
void classifierTier;
void kgTier;

export function getFastPathTiers(): Tier[] {
  return [trigramTier, entityTier];
}

export function getRescueTiers(): Tier[] {
  return [];
}
