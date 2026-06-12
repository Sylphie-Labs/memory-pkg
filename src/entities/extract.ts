/**
 * entities/extract.ts -- Deterministic entity extraction, shared by the entity
 * retrieval tier, the entity-link consolidation processor, and (vendored) the
 * ambient PostToolUse hook.
 *
 * Extracts salient identifiers from text: backtick terms, double-quoted
 * phrases, file paths, CamelCase, snake_case. The logic moved here from
 * src/inject/tiers/entity.ts so there's a single source of truth; that module
 * re-exports extractEntities for back-compat.
 *
 * normalizeEntity() is the ONE canonical normalization used everywhere an
 * entity is keyed (the memory_entities.name_norm column, the ambient session
 * ledger, dedup): lowercase + trim. Keep it dead simple — alias/case merging
 * beyond this is an explicit non-goal (it would silently corrupt the index).
 */

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
const PROSE_CHARS = /[—–'’]/;

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
  // columns, not content worth querying for. search_text is prefixed with the
  // event_type, so without these every event would yield its type as an
  // "entity" (turn_rationale was leaking before it was added here).
  'assistant_text', 'user_prompt', 'tool_call', 'tool_result', 'turn_rationale',
  'assistant_thinking',
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

export function extractEntities(text: string): string[] {
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

/**
 * The single canonical entity normalization. Used as the memory_entities key,
 * the ambient ledger key, and the ambient dedup key. Lowercase + trim only —
 * deliberately NOT alias/stem merging.
 */
export function normalizeEntity(s: string): string {
  return s.trim().toLowerCase();
}
