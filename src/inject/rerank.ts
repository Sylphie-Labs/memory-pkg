/**
 * rerank.ts -- Haiku-based relevance reranker for ambiguous memory matches.
 *
 * Trigram fuzzy search is cheap but noisy — "specialPhrase" and "specialRequest"
 * score similarly on surface form yet mean different things. For candidates in
 * the ambiguous band (neither clearly relevant nor clearly noise), a quick
 * Haiku call produces a 0/1/2 relevance verdict. Strong matches skip this
 * entirely so the hot path stays fast.
 *
 * Calls Claude via the local `claude` CLI with `-p` plus minimization flags
 * (--setting-sources user, --strict-mcp-config, --disable-slash-commands,
 * --exclude-dynamic-system-prompt-sections). Uses Max-subscription OAuth, no
 * API key, no external fetch. `--bare` is deliberately NOT used because it
 * blocks OAuth reads.
 *
 * Fails open: missing CLI, timeout, parse error, or disabled via env → all
 * candidates pass through with relevance=1 so the fuzzy tier still serves
 * a result.
 */

import { spawn } from 'child_process';
import * as os from 'os';

const MODEL = process.env.DRIFT_MEMORY_RERANK_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_BIN = process.env.MEMORY_PKG_CLAUDE_BIN || 'claude';
// Non-bare claude has 1.5-3s of startup overhead on top of the model call.
// Default 10s gives headroom; passthrough fires on timeout.
const TIMEOUT_MS = parseInt(process.env.DRIFT_MEMORY_RERANK_TIMEOUT_MS || '10000', 10);

export interface RerankInput {
  excerpt: string;
  event_type: string;
  score: number;
}

export interface RerankOutput<T extends RerankInput> {
  item: T;
  relevance: 0 | 1 | 2;
}

function buildPrompt(query: string, items: RerankInput[]): string {
  const header = `You rate how relevant past session events are to a developer's current message in Claude Code.

For each candidate, output a relevance score:
- 0 = irrelevant or noise. Drop it.
- 1 = tangentially related. Include if space permits.
- 2 = clearly relevant to what the user is asking or doing.

Be strict with 2s. Most near-miss string matches are 0 or 1.

Output strict JSON only, no prose, no markdown fences:
{"ratings":[{"index":0,"relevance":0|1|2}, ...]}
One entry per candidate, in any order.

---

User message: ${query}

Candidates:`;

  const body = items
    .map((it, i) => {
      const excerpt = (it.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      return `${i}) [${it.event_type}] ${excerpt}`;
    })
    .join('\n');

  return `${header}\n${body}\n`;
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
    // Spawn notes:
    // - shell:true required on Windows where `claude` is a .cmd shim.
    // - --bare is deliberately NOT used: --bare disables OAuth reads, which
    //   blocks Max-subscription auth. Non-bare keeps OAuth but enables hooks
    //   by default — we disable those below.
    // - --setting-sources user skips project settings (avoids loading this
    //   project's UserPromptSubmit hook which would recursively spawn claude).
    // - --strict-mcp-config skips all MCP servers (cuts ~2s of startup).
    // - --disable-slash-commands skips skills loading.
    // - cwd=tmpdir is belt-and-suspenders against project detection.
    // Single-string command avoids Node 22's shell:true+args deprecation.
    const cmd = `${CLAUDE_BIN} -p --model ${MODEL} --setting-sources user --strict-mcp-config --disable-slash-commands --exclude-dynamic-system-prompt-sections`;
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

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

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
      if (!text) {
        reject(new Error('claude CLI returned empty output'));
        return;
      }
      resolve(text);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function rerankCandidates<T extends RerankInput>(
  query: string,
  items: T[],
): Promise<RerankOutput<T>[]> {
  const passthrough = (): RerankOutput<T>[] =>
    items.map((item) => ({ item, relevance: 1 as const }));

  if (items.length === 0) return [];
  if (process.env.DRIFT_MEMORY_RERANK_DISABLED) return passthrough();

  const prompt = buildPrompt(query, items);

  let raw: string;
  try {
    raw = await callClaudeCli(prompt, TIMEOUT_MS);
  } catch {
    return passthrough();
  }

  const parsed = extractJson(raw) as { ratings?: { index: number; relevance: number }[] } | null;
  if (!parsed?.ratings || !Array.isArray(parsed.ratings)) return passthrough();

  const byIndex = new Map<number, 0 | 1 | 2>();
  for (const r of parsed.ratings) {
    if (typeof r.index !== 'number' || r.index < 0 || r.index >= items.length) continue;
    const rel = r.relevance === 0 || r.relevance === 1 || r.relevance === 2 ? r.relevance : 1;
    byIndex.set(r.index, rel);
  }
  return items.map((item, i) => ({ item, relevance: byIndex.get(i) ?? 1 }));
}
