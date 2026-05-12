/**
 * classifier.ts -- Entity-targeted retrieval tier.
 *
 * Calls classifyPrompt (Haiku) to extract {subsystems, files, entities}, then
 * queries memory_events by subsystem tag and file path suffix. Score is
 * classifier confidence × exponential recency decay (7-day half-life-ish).
 *
 * Hallucinated files are dropped via filesystem existence check.
 * Unknown subsystems are dropped via the distinct-subsystem whitelist.
 * Classification is cached on disk (10-min TTL) so repeat/followup prompts
 * skip the Haiku call.
 *
 * Disable via DRIFT_MEMORY_TIER_CLASSIFIER_DISABLED=1.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runQuery } from '../../timescale-client.js';
import {
  classifyPrompt,
  classifierCacheKey,
  getClassifierCache,
  getKnownSubsystems,
} from '../classify.js';
import type { Tier, TierInput, TierResult } from './types.js';

const TIER_NAME = 'classifier';
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const RECENCY_DAYS = 30;
const RECENCY_HALFLIFE_DAYS = 7;
const LIMIT_PER_QUERY = 20;
const MIN_CONFIDENCE = 0.3;

function validateFiles(files: string[]): string[] {
  const root = path.resolve(PROJECT_DIR);
  const valid: string[] = [];
  for (const f of files) {
    const clean = f.replace(/^\/+/, '').replace(/^\.\//, '').replace(/\\/g, '/');
    const full = path.resolve(root, clean);
    if (!full.startsWith(root)) continue;
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) valid.push(clean);
    } catch {
      // ignore
    }
  }
  return valid;
}

function validateSubsystems(subsystems: string[], known: string[]): string[] {
  const set = new Set(known);
  return subsystems.filter((s) => set.has(s));
}

export const classifierTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();

  if (process.env.DRIFT_MEMORY_TIER_CLASSIFIER_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  try {
    const known = await getKnownSubsystems();
    const cacheKey = classifierCacheKey(input.query, known);
    const cache = getClassifierCache();
    let classification = cache.get(cacheKey);

    if (!classification) {
      classification = await classifyPrompt(input.query, known);
      if (classification === null) {
        return { tier: TIER_NAME, candidates: [], latency_ms: Date.now() - t0 };
      }
      cache.set(cacheKey, classification);
    }

    if (classification.confidence < MIN_CONFIDENCE) {
      return { tier: TIER_NAME, candidates: [], latency_ms: Date.now() - t0 };
    }

    const subs = validateSubsystems(classification.subsystems, known);
    const files = validateFiles(classification.files);

    if (subs.length === 0 && files.length === 0) {
      return { tier: TIER_NAME, candidates: [], latency_ms: Date.now() - t0 };
    }

    // Build dynamic predicate. Subsystems match by equality (ANY), files match
    // by ILIKE suffix since file_path may be stored absolute or relative.
    const predicate: string[] = [];
    const params: unknown[] = [];

    if (subs.length > 0) {
      params.push(subs);
      predicate.push(`subsystem = ANY($${params.length}::text[])`);
    }
    for (const f of files) {
      params.push(`%${f}`);
      predicate.push(`file_path ILIKE $${params.length}`);
    }

    const filters: string[] = [`(${predicate.join(' OR ')})`, `event_type <> 'tool_result'`];

    if (input.excludeSelf && input.sessionId) {
      params.push(input.sessionId);
      filters.push(`session_id <> $${params.length}`);
    }

    const cutoff = new Date(Date.now() - RECENCY_DAYS * 86_400_000).toISOString();
    params.push(cutoff);
    filters.push(`ts >= $${params.length}::timestamptz`);

    const sql = `
      SELECT event_id, ts
      FROM memory_events
      WHERE ${filters.join(' AND ')}
      ORDER BY ts DESC
      LIMIT ${LIMIT_PER_QUERY}
    `;

    const rows = await runQuery<{ event_id: string; ts: string }>(sql, params);

    const now = Date.now();
    const candidates = rows.map((r) => {
      const ageDays = (now - new Date(r.ts).getTime()) / 86_400_000;
      const recency = Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
      return {
        event_id: r.event_id,
        score: classification!.confidence * recency,
        source_tier: TIER_NAME,
      };
    });

    return { tier: TIER_NAME, candidates, latency_ms: Date.now() - t0 };
  } catch (err) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
