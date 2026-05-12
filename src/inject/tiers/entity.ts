/**
 * entity.ts -- Per-entity lexical tier.
 *
 * Where trigram.ts matches the literal prompt against every event, this tier
 * extracts salient entities (code identifiers, backticked terms, file paths,
 * quoted phrases) from the current prompt + last ~20 lines of the session
 * transcript, then runs a trigram-style word_similarity query per entity in
 * parallel. Top K matches per entity are returned as candidates.
 *
 * Purpose: when the prompt is a pronoun or short reference ("ok lets do that"),
 * the literal-prompt trigram finds nothing. The entities we're actually
 * talking about live in the recent transcript — so we query for them directly.
 *
 * Metadata surfaced for the orchestrator:
 *   - queried   entities we ran DB queries for (after cap), rank order
 *   - dropped   entities extracted but cut by the cap, rank order
 *   - overflow  { entity: total_matches } when hits > per-entity cap, so the
 *                 orchestrator can hint "call searchMemory for more"
 *
 * Env toggles:
 *   DRIFT_MEMORY_TIER_ENTITY_DISABLED=1
 *   DRIFT_MEMORY_ENTITY_MAX=N       entity cap (default 8)
 *   DRIFT_MEMORY_ENTITY_PER=N       events per entity (default 2)
 *   DRIFT_MEMORY_TRANSCRIPT_TAIL=N  transcript lines to scan (default 20)
 */

import { readFileSync } from 'node:fs';
import { runQuery } from '../../timescale-client.js';
import type { Tier, TierInput, TierResult, Candidate } from './types.js';

const TIER_NAME = 'entity';
const MIN_SIMILARITY = 0.2;

// Capture group 1 = entity text. All patterns are global for `matchAll`.
// Single-quote regex was removed: contractions (isn't, it's) consistently
// produced garbage captures like "t a new tier — it" that poisoned the
// query list. Double-quote + backtick cover the legitimate cases.
const RE_BACKTICK = /`([^`\n]{2,64})`/g;
const RE_DOUBLE_QUOTE = /"([^"\n]{3,64})"/g;
// File-like: must contain at least one letter in the stem, ext 2-5 letters.
const RE_FILE = /\b([\w./-]*[a-zA-Z][\w./-]*\.[a-zA-Z]{2,5})\b/g;
// CamelCase: at least two capital-letter transitions so `Postgres` alone misses.
const RE_CAMEL = /\b([A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g;
// snake_case: at least one underscore between alnum runs.
const RE_SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

const REGEXES: RegExp[] = [
  RE_BACKTICK,
  RE_DOUBLE_QUOTE,
  RE_FILE,
  RE_CAMEL,
  RE_SNAKE,
];

// Code-syntax / placeholder / regex characters. If a capture contains any of
// these it's likely a code fragment ("foo?: string", "DRIFT_X=1", "foo<T>"),
// a placeholder ("[entity]"), or a regex ("\S+") — poor search query.
const CODE_SYNTAX_CHARS = /[:=<>?(){}\[\]\\|+*]/;
// Prose markers: em/en dashes and apostrophes inside a capture mean it's a
// sentence fragment, not an identifier.
const PROSE_CHARS = /[\u2014\u2013'\u2019]/;

// Common-word noise that slips through the shape filters. Grouped for clarity.
const STOPWORDS = new Set([
  // generic english / code filler
  'true', 'false', 'null', 'undefined', 'none', 'todo', 'note', 'readme',
  'license', 'package', 'config', 'index', 'main', 'utils', 'helper',
  'example', 'sample', 'default', 'this', 'that', 'these', 'those',
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'yours',
  // windows/unix path components (leak from absolute paths in transcripts)
  'onedrive', 'appdata', 'users', 'desktop', 'code', 'programfiles',
  'roaming', 'documents', 'downloads', 'local', 'temp', 'home',
  // memory_events schema column values (event_type) — these are table
  // columns, not content worth querying for
  'assistant_text', 'user_prompt', 'tool_call', 'tool_result',
]);

// Drop absolute path prefixes so components like "OneDrive"/"AppData" don't
// leak out as separate CamelCase entities. Leaves relative path tails intact
// for the file regex to catch as a single entity.
function stripAbsolutePaths(text: string): string {
  return text
    // Windows drive-letter paths: "C:\Users\Jim\..."
    .replace(/[A-Za-z]:[\\/](?:[^\s`"'\n\\/]+[\\/])+/g, '')
    // Git-Bash style: "/c/Users/Jim/..."
    .replace(/\/[a-zA-Z]\/Users\/[^\s`"'\n/]+\//g, '')
    // Unix home paths: "/home/jim/..."
    .replace(/\/home\/[^\s`"'\n/]+\//g, '');
}

function extractEntities(text: string): string[] {
  if (!text) return [];
  const corpus = stripAbsolutePaths(text);
  const out = new Set<string>();
  for (const re of REGEXES) {
    for (const m of corpus.matchAll(re)) {
      const raw = (m[1] ?? '').trim();
      if (raw.length < 3 || raw.length > 40) continue;
      if (STOPWORDS.has(raw.toLowerCase())) continue;
      if (CODE_SYNTAX_CHARS.test(raw)) continue;
      if (PROSE_CHARS.test(raw)) continue;
      // Drop multi-word captures > 2 words — those are phrases not entities.
      if ((raw.match(/\s+/g)?.length ?? 0) > 1) continue;
      // All-caps captures (TOP, CLI, API) match the CamelCase regex but are
      // usually acronyms/noise — require ≥1 lowercase letter.
      if (!/[a-z]/.test(raw)) continue;
      out.add(raw);
    }
  }
  return [...out];
}

// Pull readable text out of a Claude Code transcript JSONL entry. The
// format is { type, message: { content: string | ContentBlock[] }, ... }
// but we walk defensively so format drift degrades gracefully.
function stringifyContent(obj: unknown): string {
  if (typeof obj === 'string') return obj;
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as Record<string, unknown>;
  if (typeof o.content === 'string') return o.content;
  if (Array.isArray(o.content)) {
    return (o.content as unknown[]).map(stringifyContent).join('\n');
  }
  if (o.message !== undefined) return stringifyContent(o.message);
  if (typeof o.text === 'string') return o.text;
  return '';
}

function loadTranscriptTail(path: string, maxLines: number): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines);
  const chunks: string[] = [];
  for (const line of tail) {
    try {
      chunks.push(stringifyContent(JSON.parse(line)));
    } catch {
      chunks.push(line);
    }
  }
  return chunks.join('\n');
}

interface Row {
  event_id: string;
  score: number;
}

interface EntityHit {
  entity: string;
  rows: Row[];
}

async function queryEntity(
  entity: string,
  input: TierInput,
  overfetch: number,
): Promise<EntityHit> {
  const filters: string[] = [
    'search_text IS NOT NULL',
    'excerpt IS NOT NULL',
    `event_type <> 'tool_result'`,
  ];
  const params: unknown[] = [entity];
  let i = 2;
  if (input.excludeSelf && input.sessionId) {
    filters.push(`session_id <> $${i++}`);
    params.push(input.sessionId);
  }
  params.push(MIN_SIMILARITY);
  const minIdx = i++;
  params.push(overfetch);
  const limitIdx = i;

  const sql = `
    SELECT event_id, word_similarity($1, search_text) AS score
    FROM memory_events
    WHERE ${filters.join(' AND ')}
      AND word_similarity($1, search_text) >= $${minIdx}
    ORDER BY score DESC, ts DESC
    LIMIT $${limitIdx}
  `;
  const rows = await runQuery<Row>(sql, params);
  return { entity, rows };
}

export const entityTier: Tier = async (input: TierInput): Promise<TierResult> => {
  const t0 = Date.now();
  if (process.env.DRIFT_MEMORY_TIER_ENTITY_DISABLED) {
    return { tier: TIER_NAME, candidates: [], latency_ms: 0, disabled: true };
  }

  const maxEntities = Math.max(1, parseInt(process.env.DRIFT_MEMORY_ENTITY_MAX || '8', 10));
  const perEntity = Math.max(1, parseInt(process.env.DRIFT_MEMORY_ENTITY_PER || '2', 10));
  const tailLines = Math.max(1, parseInt(process.env.DRIFT_MEMORY_TRANSCRIPT_TAIL || '20', 10));
  // Overfetch so we can detect per-entity overflow without a second query.
  const overfetch = Math.max(perEntity + 1, 10);

  const promptEntities = extractEntities(input.query || '');
  const transcriptEntities = input.transcriptPath
    ? extractEntities(loadTranscriptTail(input.transcriptPath, tailLines))
    : [];

  // Rank entities: current prompt double-weighted, transcript mentions single.
  const scores = new Map<string, number>();
  for (const e of promptEntities) scores.set(e, (scores.get(e) ?? 0) + 2);
  for (const e of transcriptEntities) scores.set(e, (scores.get(e) ?? 0) + 1);

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e);

  const queried = ranked.slice(0, maxEntities);
  const dropped = ranked.slice(maxEntities);

  if (queried.length === 0) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      metadata: { queried: [], dropped: [], overflow: {} },
    };
  }

  let hits: EntityHit[];
  try {
    hits = await Promise.all(queried.map((e) => queryEntity(e, input, overfetch)));
  } catch (err) {
    return {
      tier: TIER_NAME,
      candidates: [],
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      metadata: { queried, dropped, overflow: {} },
    };
  }

  const byId = new Map<string, Candidate>();
  const overflow: Record<string, number> = {};
  for (const hit of hits) {
    if (hit.rows.length > perEntity) overflow[hit.entity] = hit.rows.length;
    for (const row of hit.rows.slice(0, perEntity)) {
      const score = Number(row.score);
      const existing = byId.get(row.event_id);
      if (!existing || score > existing.score) {
        byId.set(row.event_id, {
          event_id: row.event_id,
          score,
          source_tier: TIER_NAME,
          rationale: `entity:${hit.entity}`,
        });
      }
    }
  }
  const candidates = [...byId.values()].sort((a, b) => b.score - a.score);

  return {
    tier: TIER_NAME,
    candidates,
    latency_ms: Date.now() - t0,
    metadata: { queried, dropped, overflow },
  };
};
