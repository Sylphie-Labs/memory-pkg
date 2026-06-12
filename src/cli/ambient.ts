/**
 * ambient.ts -- `memory-pkg ambient -` : mid-turn ambient recall for the
 * PostToolUse hook. Point-lookup over the entity graph ONLY — no embedding
 * tier, no merger, no rerank, ever (this is a hot path, ≤5s, trigram/index
 * speed). Reads {session_id, entities[]} from stdin, writes a compact
 * <ambient-memory> block (or a one-line searchMemory hint, or nothing) and a
 * memory_injections row, and prints JSON {text, injected} for the hook.
 *
 * Content bias (D15): inject excerpts ONLY from turn_rationale / assistant_text
 * (conclusions), never tool_call/tool_result (mechanics). A one-hop rationale
 * (entity → event → turn → rationale) counts as strong content.
 */

import { runQuery } from '../timescale-client.js';
import { normalizeEntity } from '../entities/extract.js';
import { recordInjection } from '../feedback/record-injection.js';

const MAX_ITEMS = 2;
const MAX_CHARS = 800;

interface AmbientInput {
  session_id?: string;
  entities?: string[];
}

interface CandidateRow {
  event_id: string;
  score: number;
  event_type: string;
  ts: string;
  excerpt: string | null;
  summary: string | null;
  file_path: string | null;
}

async function strongCandidates(norms: string[], sessionId: string | undefined): Promise<CandidateRow[]> {
  const params: unknown[] = [norms];
  let sessionFilter = '';
  if (sessionId) {
    sessionFilter = `AND l.session_id <> $2`;
    params.push(sessionId);
  }
  // direct links biased by type, plus the one-hop rationale of any linked turn.
  return runQuery<CandidateRow>(
    `
    WITH ents AS (
      SELECT entity_id FROM memory_entities WHERE name_norm = ANY($1::text[])
    ),
    links AS (
      SELECT l.event_id, l.event_type, l.turn_user_prompt_id
      FROM ents e JOIN memory_entity_events l ON l.entity_id = e.entity_id
      WHERE l.event_type <> 'tool_result' ${sessionFilter}
    ),
    direct AS (
      SELECT event_id,
             (CASE event_type WHEN 'turn_rationale' THEN 1.0 WHEN 'assistant_text' THEN 0.9 ELSE 0.5 END) AS score
      FROM links
    ),
    hop AS (
      SELECT r.event_id, 0.85 AS score
      FROM memory_events r
      WHERE r.event_type = 'turn_rationale'
        AND r.payload->>'source_user_prompt_id' IN (
          SELECT DISTINCT turn_user_prompt_id::text FROM links WHERE turn_user_prompt_id IS NOT NULL
        )
    ),
    cand AS (
      SELECT event_id, max(score) AS score
      FROM (SELECT * FROM direct UNION ALL SELECT * FROM hop) u
      GROUP BY event_id
    )
    SELECT ev.event_id, c.score, ev.event_type, ev.ts, ev.excerpt, ev.summary, ev.file_path
    FROM cand c
    JOIN memory_events ev ON ev.event_id = c.event_id
    WHERE ev.event_type IN ('turn_rationale', 'assistant_text')
      AND COALESCE(ev.excerpt, ev.summary) IS NOT NULL
    ORDER BY c.score DESC, ev.ts DESC
    LIMIT 6
    `,
    params,
  );
}

interface FactRow {
  fact_id: string;
  fact_text: string;
  cluster_key: string;
}

async function factsForEntities(norms: string[]): Promise<FactRow[]> {
  try {
    return await runQuery<FactRow>(
      `SELECT fact_id, fact_text, cluster_key FROM memory_facts
       WHERE status = 'active' AND cluster_key = ANY($1::text[])`,
      [norms],
    );
  } catch {
    return []; // pre-v4 schema
  }
}

async function knownEntities(norms: string[]): Promise<string[]> {
  const rows = await runQuery<{ name_norm: string }>(
    `SELECT name_norm FROM memory_entities WHERE name_norm = ANY($1::text[])`,
    [norms],
  );
  return rows.map((r) => r.name_norm);
}

export async function runAmbient(): Promise<void> {
  const raw = await readStdin();
  let input: AmbientInput;
  try {
    input = JSON.parse(raw) as AmbientInput;
  } catch {
    process.stdout.write(JSON.stringify({ text: '', injected: false }));
    return;
  }

  const norms = [...new Set((input.entities ?? []).map(normalizeEntity).filter(Boolean))];
  if (norms.length === 0) {
    process.stdout.write(JSON.stringify({ text: '', injected: false }));
    return;
  }

  // Curated facts win: a fact about an entity the agent just touched is the
  // highest-value thing we can inject.
  const facts = await factsForEntities(norms);
  if (facts.length > 0) {
    const picked = facts.slice(0, MAX_ITEMS);
    const injectionId = await recordInjection({
      sessionId: input.session_id ?? null,
      trigger: 'ambient',
      queryOrEntity: norms.join(','),
      items: picked.map((f) => ({ item_id: f.fact_id, item_kind: 'fact' as const, summary120: f.fact_text.slice(0, 120) })),
      charsInjected: picked.reduce((n, f) => n + f.fact_text.length, 0),
    });
    const body = picked.map((f) => `### fact · ${f.cluster_key}\n> ${f.fact_text.replace(/\n/g, '\n> ')}\n`).join('\n');
    const text =
      `<ambient-memory source="background" injection: ${injectionId}>\n` +
      `Curated facts about what you're exploring (${norms.join(', ')}). Reference only.\n\n` +
      `${body}</ambient-memory>`;
    process.stdout.write(JSON.stringify({ text, injected: true }));
    return;
  }

  let cands: CandidateRow[] = [];
  try {
    cands = await strongCandidates(norms, input.session_id);
  } catch {
    process.stdout.write(JSON.stringify({ text: '', injected: false }));
    return;
  }

  // Strong path: build a compact block from the top items within budget.
  const picked: CandidateRow[] = [];
  const blocks: string[] = [];
  let chars = 0;
  for (const c of cands) {
    if (picked.length >= MAX_ITEMS) break;
    const excerpt = (c.excerpt ?? c.summary ?? '').trim();
    if (!excerpt) continue;
    const date = new Date(c.ts).toISOString().slice(0, 10);
    const file = c.file_path ? ` · ${c.file_path}` : '';
    const block = `### ${c.event_type}${file} · ${date}\n> ${excerpt.replace(/\n/g, '\n> ')}\n`;
    if (chars + block.length > MAX_CHARS) break;
    blocks.push(block);
    chars += block.length;
    picked.push(c);
  }

  if (picked.length > 0) {
    const injectionId = await recordInjection({
      sessionId: input.session_id ?? null,
      trigger: 'ambient',
      queryOrEntity: norms.join(','),
      items: picked.map((c) => ({
        item_id: c.event_id,
        item_kind: 'event' as const,
        summary120: (c.excerpt ?? c.summary ?? '').trim().slice(0, 120),
      })),
      charsInjected: chars,
      shadowScores: undefined,
    });
    const header =
      `<ambient-memory source="background" injection: ${injectionId}>\n` +
      `Possibly-relevant past work surfaced while you were exploring (entities: ${norms.join(', ')}). ` +
      `Reference only; not current state.\n\n`;
    const text = header + blocks.join('\n') + `</ambient-memory>`;
    process.stdout.write(JSON.stringify({ text, injected: true }));
    return;
  }

  // Weak path: the entity exists but has no conclusion-grade content — hint.
  let known: string[] = [];
  try {
    known = await knownEntities(norms);
  } catch {
    known = [];
  }
  if (known.length > 0) {
    const e = known[0];
    const text =
      `<ambient-memory source="background">\n` +
      `Past work on "${e}" exists in long-term memory. ` +
      `Call mcp__memory-pkg__searchMemory({ query: "${e}" }) if it's relevant.\n` +
      `</ambient-memory>`;
    process.stdout.write(JSON.stringify({ text, injected: false }));
    return;
  }

  // Empty: nothing known.
  process.stdout.write(JSON.stringify({ text: '', injected: false }));
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => (buf += c.toString('utf8')));
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}
