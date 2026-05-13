/**
 * classify.ts -- Haiku-based entity classifier for the classifier retrieval tier.
 *
 * Given a user prompt and the list of known subsystems in the repo, asks Haiku
 * to return a structured JSON classification: intent, candidate subsystems,
 * candidate files, named entities, confidence. Used by tiers/classifier.ts to
 * target memory retrieval by entity instead of similarity.
 *
 * Calls Claude via the local `claude` CLI with `-p` (non-interactive) plus
 * minimization flags. See rerank.ts for the detailed spawn rationale. Uses
 * Max-subscription OAuth (no `--bare`, which would require ANTHROPIC_API_KEY).
 *
 * Fails closed: missing CLI, timeout, parse error → returns null; tier then
 * produces zero candidates for this turn.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runQuery } from '../timescale-client.js';
import { getModelFor } from '../config.js';
import { DiskTTLCache, hashPrompt } from './cache.js';

const CLAUDE_BIN = process.env.MEMORY_PKG_CLAUDE_BIN || 'claude';
// Non-bare claude has 1.5-3s of startup overhead on top of the model call.
// Default 12s gives comfortable headroom for Haiku; classifier tier will cap
// overall latency lower via its own fallback if needed.
const TIMEOUT_MS = parseInt(process.env.MEMORY_PKG_CLASSIFY_TIMEOUT_MS || '12000', 10);

// 24h default — classifier output rarely rots (intent/entities are stable;
// file paths self-heal via validateFiles; subsystem staleness is handled by
// keying the cache on (prompt + subsystem-list), so re-ingestion naturally
// invalidates). Override via MEMORY_PKG_CLASSIFIER_CACHE_TTL_MS.
const CACHE_TTL_MS = parseInt(
  process.env.MEMORY_PKG_CLASSIFIER_CACHE_TTL_MS || String(24 * 60 * 60 * 1000),
  10,
);
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const CACHE_FILE = path.join(PROJECT_DIR, '.claude', 'memory', 'cache', 'classifier.json');

let _cache: DiskTTLCache<ClassifierOutput> | null = null;
export function getClassifierCache(): DiskTTLCache<ClassifierOutput> {
  if (_cache === null) _cache = new DiskTTLCache<ClassifierOutput>(CACHE_FILE, CACHE_TTL_MS);
  return _cache;
}

/**
 * Compose the classifier cache key from the prompt AND the current subsystem
 * whitelist, so ingest-induced subsystem additions naturally invalidate.
 */
export function classifierCacheKey(query: string, knownSubsystems: string[]): string {
  const sortedSubsystems = [...knownSubsystems].sort().join(',');
  return hashPrompt(query + '|' + sortedSubsystems);
}

let _knownSubsystems: { list: string[]; at: number } | null = null;
export async function getKnownSubsystems(): Promise<string[]> {
  const now = Date.now();
  if (_knownSubsystems && now - _knownSubsystems.at < 60_000) {
    return _knownSubsystems.list;
  }
  const rows = await runQuery<{ subsystem: string }>(
    `SELECT DISTINCT subsystem FROM memory_events WHERE subsystem IS NOT NULL ORDER BY subsystem`,
  );
  const list = rows.map((r) => r.subsystem);
  _knownSubsystems = { list, at: now };
  return list;
}

export interface ClassifierOutput {
  intent: 'implement' | 'debug' | 'question' | 'status' | 'plan' | 'other';
  subsystems: string[];
  files: string[];
  entities: string[];
  confidence: number;
}

/**
 * Project-specific context for the classifier prompt. Read from a markdown
 * file the consumer maintains (default `.memory-pkg/classifier-context.md`,
 * overridable via MEMORY_PKG_CLASSIFIER_CONTEXT_FILE). When the file is
 * missing or empty, a generic baked-in default is used.
 *
 * The file's contents are inserted verbatim under a "Project context" heading
 * in the prompt, so the consumer can describe their repo layout, key
 * subsystems, conventions — whatever best matches their codebase.
 */
const GENERIC_PROJECT_CONTEXT =
  `This is the user's codebase. The subsystem list below is derived from ` +
  `paths seen in past events; trust it as the source of truth for what's ` +
  `present in the repo. Files referenced in the user message should be ` +
  `paths relative to the repo root.`;

let _projectContext: string | undefined;

function loadProjectContext(): string {
  if (_projectContext !== undefined) return _projectContext;

  const contextPath =
    process.env.MEMORY_PKG_CLASSIFIER_CONTEXT_FILE ??
    path.join(PROJECT_DIR, '.memory-pkg', 'classifier-context.md');

  try {
    if (fs.existsSync(contextPath)) {
      const raw = fs.readFileSync(contextPath, 'utf8').trim();
      if (raw) {
        _projectContext = raw;
        return _projectContext;
      }
    }
  } catch {
    // fall through to default
  }

  _projectContext = GENERIC_PROJECT_CONTEXT;
  return _projectContext;
}

function buildPrompt(query: string, knownSubsystems: string[]): string {
  const projectContext = loadProjectContext();

  return `You classify a developer's Claude Code message to target memory retrieval.

## Project context
${projectContext}

## Known subsystems in this repo (choose from these when possible)
${knownSubsystems.join(', ') || '(none yet)'}

## Output
Strict JSON (no prose, no markdown fences):
{"intent":"implement|debug|question|status|plan|other","subsystems":["..."],"files":["relative/path.ts"],"entities":["concept"],"confidence":0.0-1.0}

## Rules
- subsystems: pick from the known list when the message is about one of them; leave empty if not subsystem-specific.
- files: only paths explicitly mentioned or very clearly implied. Relative to repo root.
- entities: short named concepts (e.g. "rerank", "hybrid retrieval", "classifier cache").
- confidence: your confidence the above captures the message. Short, ambiguous, or off-topic messages get <=0.3.

## User message
${query}
`;
}

function extractJson(text: string): unknown | null {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function callClaudeCli(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // See rerank.ts for the detailed spawn rationale. Summary: non-bare mode
    // keeps Max OAuth; setting-sources/strict-mcp/disable-slash-commands
    // trim startup; tmpdir cwd avoids project-hook recursion.
    const cmd = `${CLAUDE_BIN} -p --model ${getModelFor('classify')} --setting-sources user --strict-mcp-config --disable-slash-commands --exclude-dynamic-system-prompt-sections`;
    const proc = spawn(cmd, {
      shell: true,
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`spawn ${CLAUDE_BIN} failed: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}. stderr: ${stderr.slice(0, 300)}`));
        return;
      }
      const text = stdout.trim();
      if (!text) { reject(new Error('claude CLI returned empty output')); return; }
      resolve(text);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function coerceIntent(raw: unknown): ClassifierOutput['intent'] {
  const v = typeof raw === 'string' ? raw.toLowerCase() : '';
  const allowed: ClassifierOutput['intent'][] = ['implement', 'debug', 'question', 'status', 'plan', 'other'];
  return (allowed as string[]).includes(v) ? (v as ClassifierOutput['intent']) : 'other';
}

function coerceStrArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export async function classifyPrompt(
  query: string,
  knownSubsystems: string[],
): Promise<ClassifierOutput | null> {
  if (process.env.DRIFT_MEMORY_CLASSIFY_DISABLED) return null;

  const prompt = buildPrompt(query, knownSubsystems);

  let raw: string;
  try {
    raw = await callClaudeCli(prompt, TIMEOUT_MS);
  } catch {
    return null;
  }

  const parsed = extractJson(raw) as Partial<ClassifierOutput> | null;
  if (!parsed || typeof parsed !== 'object') return null;

  const conf = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.5;

  return {
    intent: coerceIntent(parsed.intent),
    subsystems: coerceStrArray(parsed.subsystems),
    files: coerceStrArray(parsed.files),
    entities: coerceStrArray(parsed.entities),
    confidence: conf,
  };
}
