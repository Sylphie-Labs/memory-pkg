/**
 * kg.ts -- Knowledge-graph expansion tier.
 *
 * Reads the classifier's cached file list for this prompt, expands each file
 * depth-1 through codebase-pkg's Neo4j graph (both IMPORTS directions), then
 * queries memory_events for recent events on any expanded file.
 *
 * Depends on the classifier tier having populated the disk cache earlier in
 * the same orchestrator run — the generate.ts orchestrator runs this tier
 * AFTER the parallel phase (trigram/embedding/classifier) so the cache is
 * fresh. If classifier produced no files, this tier returns empty.
 *
 * Uses neo4j-driver directly against the codebase-pkg Neo4j instance
 * (bolt://localhost:7688 by default — overridable via CODEBASE_PKG_NEO4J_URI).
 * Fails open when the graph is unreachable or empty.
 *
 * Disable via DRIFT_MEMORY_TIER_KG_DISABLED=1.
 */

import neo4j from 'neo4j-driver';
import { runQuery as runPgQuery } from '../../timescale-client.js';
import {
  classifierCacheKey,
  getClassifierCache,
  getKnownSubsystems,
} from '../classify.js';
import type { Tier, TierInput, TierResult } from './types.js';

const TIER_NAME = 'kg';
const LIMIT_PER_QUERY = 20;
const RECENCY_DAYS = 30;
const RECENCY_HALFLIFE_DAYS = 7;
const KG_SCORE_DISCOUNT = 0.7;
const NEO4J_TIMEOUT_MS = 2000;

async function expandFiles(seedFiles: string[]): Promise<string[]> {
  if (seedFiles.length === 0) return [];

  const URI = process.env.CODEBASE_PKG_NEO4J_URI ?? 'bolt://localhost:7687';
  const USER = process.env.CODEBASE_PKG_NEO4J_USER ?? 'neo4j';
  const PASSWORD = process.env.CODEBASE_PKG_NEO4J_PASSWORD ?? 'codebase-pkg-local';

  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD), {
    connectionAcquisitionTimeout: NEO4J_TIMEOUT_MS,
  });
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });

  try {
    const result = await session.run(
      `
      MATCH (m:Module)-[:IMPORTS]->(related:Module)
      WHERE m.filePath IN $files OR ANY(f IN $files WHERE m.filePath ENDS WITH f)
      RETURN DISTINCT related.filePath AS filePath
      UNION
      MATCH (related:Module)-[:IMPORTS]->(m:Module)
      WHERE m.filePath IN $files OR ANY(f IN $files WHERE m.filePath ENDS WITH f)
      RETURN DISTINCT related.filePath AS filePath
      `,
      { files: seedFiles },
    );
    return result.records
      .map((r) => r.get('filePath') as string)
      .filter((p) => typeof p === 'string' && p.length > 0);
  } finally {
    await session.close();
    await driver.close();
  }
}

export const kgTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();

  if (process.env.DRIFT_MEMORY_TIER_KG_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  try {
    // Same cache key logic as the classifier tier so the two stay in sync.
    // If classifier hasn't populated the cache yet this run, we skip silently.
    const known = await getKnownSubsystems();
    const classification = getClassifierCache().get(classifierCacheKey(input.query, known));
    if (!classification || classification.files.length === 0) {
      return { tier: TIER_NAME, candidates: [], latency_ms: Date.now() - t0 };
    }

    const expanded = await expandFiles(classification.files);
    if (expanded.length === 0) {
      return { tier: TIER_NAME, candidates: [], latency_ms: Date.now() - t0 };
    }

    // Query memory_events for recent events on expanded files.
    const predicate: string[] = [];
    const params: unknown[] = [];
    for (const f of expanded) {
      params.push(`%${f}`);
      predicate.push(`file_path ILIKE $${params.length}`);
    }

    const filters: string[] = [
      `(${predicate.join(' OR ')})`,
      `event_type <> 'tool_result'`,
    ];

    if (input.excludeSelf && input.sessionId) {
      params.push(input.sessionId);
      filters.push(`session_id <> $${params.length}`);
    }

    params.push(new Date(Date.now() - RECENCY_DAYS * 86_400_000).toISOString());
    filters.push(`ts >= $${params.length}::timestamptz`);

    const sql = `
      SELECT event_id, ts
      FROM memory_events
      WHERE ${filters.join(' AND ')}
      ORDER BY ts DESC
      LIMIT ${LIMIT_PER_QUERY}
    `;

    const rows = await runPgQuery<{ event_id: string; ts: string }>(sql, params);

    const now = Date.now();
    const baseScore = classification.confidence * KG_SCORE_DISCOUNT;
    const candidates = rows.map((r) => {
      const ageDays = (now - new Date(r.ts).getTime()) / 86_400_000;
      const recency = Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
      return {
        event_id: r.event_id,
        score: baseScore * recency,
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
