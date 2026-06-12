/**
 * facts-promote (deep) -- Distill high-usefulness entity clusters into curated
 * facts. Its OWN prompt and cadence, not bolted onto per-turn rationale.
 *
 * A cluster = an entity. It qualifies when its linked events carry n ≥ 3 blended
 * ratings with a blended mean ≥ +0.6. For each qualifying cluster we gather the
 * top rationale/assistant_text excerpts, synthesize 1–3 declarative sentences,
 * and store an active memory_facts row (one per cluster — the partial unique
 * index enforces it; re-promotion supersedes). Idempotent: a cluster whose
 * active fact already covers its newest qualifying event is skipped.
 */

import { randomUUID } from 'crypto';
import { runQuery, getPool } from '../../timescale-client.js';
import { callClaudeCli } from '../../llm/claude-cli.js';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const PROMOTE_MIN_N = 3;
const PROMOTE_MIN_MEAN = 0.6;
const MAX_EXCERPTS = 8;

// Injectable so tests don't spawn the real `claude` CLI.
let synthesizeFn: (prompt: string) => Promise<string> = (prompt) => callClaudeCli(prompt, 'rationale');
export function setFactSynthesizer(fn: (prompt: string) => Promise<string>): () => void {
  const prev = synthesizeFn;
  synthesizeFn = fn;
  return () => { synthesizeFn = prev; };
}

interface Cluster {
  cluster_key: string;
  event_ids: string[];
  newest_ts: string;
}

async function qualifyingClusters(): Promise<Cluster[]> {
  return runQuery<Cluster>(
    `SELECT e.name_norm AS cluster_key,
            array_agg(DISTINCT l.event_id) AS event_ids,
            max(l.event_ts) AS newest_ts
     FROM memory_entity_events l
     JOIN memory_entities e ON e.entity_id = l.entity_id
     JOIN memory_event_stats s ON s.item_id = l.event_id
     WHERE e.name_norm <> ''
     GROUP BY e.name_norm
     HAVING sum(s.n_self + 0.5 * s.n_implicit) >= ${PROMOTE_MIN_N}
        AND sum(s.sum_self + 0.5 * s.sum_implicit)
            / NULLIF(sum(s.n_self + 0.5 * s.n_implicit), 0) >= ${PROMOTE_MIN_MEAN}`,
  );
}

function buildFactPrompt(clusterKey: string, excerpts: string[]): string {
  return `You are distilling durable project knowledge about "${clusterKey}" from past work notes.

## Notes
${excerpts.map((e, i) => `${i + 1}. ${e}`).join('\n')}

## Task
Write 1–3 short declarative sentences capturing the durable facts about "${clusterKey}" — what it is, how it relates to other parts of the system, and any decision that stuck. Present tense, no preamble, no hedging. Output only the sentences.`;
}

export const factsPromoteProcessor: Processor = {
  name: 'facts-promote',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    let clusters: Cluster[];
    try {
      clusters = await qualifyingClusters();
    } catch (err) {
      ctx.log(`facts-promote query failed: ${err instanceof Error ? err.message : String(err)}`);
      return { processed: 0, skipped: 0, exhausted: false };
    }

    let processed = 0;
    let skipped = 0;
    for (const cl of clusters) {
      if (Date.now() >= ctx.deadline) return { processed, skipped, exhausted: false };

      // Idempotency: skip if the active fact already covers the newest event.
      const existing = await runQuery<{ fact_id: string; derived_through_ts: string }>(
        `SELECT fact_id, derived_through_ts FROM memory_facts WHERE cluster_key = $1 AND status = 'active'`,
        [cl.cluster_key],
      );
      if (existing.length > 0 && new Date(existing[0].derived_through_ts) >= new Date(cl.newest_ts)) {
        skipped++;
        continue;
      }

      const ex = await runQuery<{ text: string }>(
        `SELECT COALESCE(ev.excerpt, ev.summary) AS text
         FROM memory_entity_events l
         JOIN memory_events ev ON ev.event_id = l.event_id AND ev.ts = l.event_ts
         JOIN memory_entities e ON e.entity_id = l.entity_id
         WHERE e.name_norm = $1 AND ev.event_type IN ('turn_rationale', 'assistant_text')
           AND COALESCE(ev.excerpt, ev.summary) IS NOT NULL
         ORDER BY ev.ts DESC LIMIT ${MAX_EXCERPTS}`,
        [cl.cluster_key],
      );
      const excerpts = ex.map((r) => r.text).filter(Boolean);
      if (excerpts.length === 0) {
        skipped++;
        continue;
      }

      let factText: string;
      try {
        factText = (await synthesizeFn(buildFactPrompt(cl.cluster_key, excerpts))).trim().slice(0, 1000);
      } catch (err) {
        ctx.log(`facts-promote synth failed for ${cl.cluster_key}: ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
        continue;
      }
      if (!factText) {
        skipped++;
        continue;
      }

      // Supersede any active fact, then insert the new one (one active/cluster).
      const newId = randomUUID();
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        if (existing.length > 0) {
          await client.query(
            `UPDATE memory_facts SET status = 'superseded', superseded_by = $1 WHERE fact_id = $2`,
            [newId, existing[0].fact_id],
          );
        }
        await client.query(
          `INSERT INTO memory_facts
             (fact_id, cluster_key, fact_text, search_text, source_event_ids, derived_through_ts, status)
           VALUES ($1, $2, $3, $4, $5::uuid[], $6::timestamptz, 'active')`,
          [newId, cl.cluster_key, factText, `${cl.cluster_key} ${factText}`.slice(0, 2000), cl.event_ids, cl.newest_ts],
        );
        await client.query('COMMIT');
        processed++;
        ctx.log(`facts-promote ${cl.cluster_key} -> ${newId.slice(0, 8)}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        ctx.log(`facts-promote insert failed for ${cl.cluster_key}: ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
      } finally {
        client.release();
      }
    }

    return { processed, skipped, exhausted: true };
  },
};
