#!/usr/bin/env node
/**
 * memory-inject.cjs -- UserPromptSubmit hook that runs the multi-tier
 * retrieval pipeline and injects top matches into the turn's context via
 * hookSpecificOutput.additionalContext.
 *
 * Degrades gracefully: if the compiled CLI isn't present (first-run before
 * `pnpm install && pnpm build`), if the DB is unreachable, or if the pipeline
 * exceeds the timeout, the hook returns empty output and never blocks the
 * user's message.
 *
 * Latency budget:
 *   - Fast path (trigram + embedding, no LLM tiers): ~600ms–1.5s
 *   - Warm classifier cache hit: ~1–2s
 *   - Cold classifier (Haiku call): ~6–10s
 *   - Rerank on ambiguous candidates: +4–8s (default-disabled; enable via env)
 * Timeout is set well above worst-case cold so first-in-session prompts still
 * get injection. Overridable via DRIFT_MEMORY_HOOK_TIMEOUT_MS.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Resolve the installed @sylphie-labs/memory-pkg CLI. Standard layout first;
// fall back to MEMORY_PKG_CLI_PATH for workspace/monorepo overrides.
function resolveCliPath() {
  const candidates = [
    process.env.MEMORY_PKG_CLI_PATH,
    path.join(PROJECT_DIR, "node_modules", "@sylphie-labs", "memory-pkg", "dist", "cli", "memory-pkg.js"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const CLI_PATH = resolveCliPath();
const TIMEOUT_MS = parseInt(
  process.env.MEMORY_PKG_HOOK_TIMEOUT_MS || process.env.DRIFT_MEMORY_HOOK_TIMEOUT_MS || "30000",
  10,
);

function emit(additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const prompt = payload?.prompt || payload?.user_prompt || payload?.text || "";
    const sessionId = payload?.session_id;
    const transcriptPath = payload?.transcript_path;

    // Mark the turn boundary for the ambient hook's per-turn injection cap:
    // append a {t:"reset"} line to the ambient ledger (best effort). This is the
    // only place that knows a new turn has started (PostToolUse can't tell).
    if (sessionId) {
      try {
        const ambientDir = path.join(PROJECT_DIR, ".claude", "memory", "ambient");
        fs.mkdirSync(ambientDir, { recursive: true });
        fs.appendFileSync(path.join(ambientDir, `${sessionId}.jsonl`), JSON.stringify({ t: "reset" }) + "\n", "utf8");
      } catch {
        // best effort
      }
    }

    if (!prompt || prompt.length < 6) return process.exit(0);
    if (!CLI_PATH) return process.exit(0); // memory-pkg not installed / not resolvable

    // Pass the prompt via the child's stdin ('-' sentinel) rather than argv:
    // Windows caps the spawn command line near 32KB, and long pasted prompts
    // were silently killing injection. The CLI treats 'inject -' as
    // read-prompt-from-stdin.
    const args = ["--enable-source-maps", CLI_PATH, "inject", "-"];
    if (sessionId) args.push("--session", sessionId);
    if (transcriptPath) args.push("--transcript", transcriptPath);

    const res = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      cwd: PROJECT_DIR,
      input: prompt,
    });

    if (res.status !== 0) return process.exit(0);
    const out = (res.stdout || "").trim();
    if (!out) return process.exit(0);

    emit(out);
  } catch {
    // Never block a user prompt.
  }
  process.exit(0);
});
