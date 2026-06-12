#!/usr/bin/env node
/**
 * memory-ambient.cjs -- PostToolUse hook for ambient mid-turn memory recall.
 *
 * As Claude works (Grep/Glob/Read/Task), it surfaces "entities of interest" in
 * the tool INPUT (the grep pattern, the file it chose to open). This hook
 * extracts those entities in-process (no spawn), dedupes them against a
 * per-session ledger, and — only when a genuinely new entity appears and the
 * per-turn / per-session injection caps aren't hit — spawns the memory-pkg CLI
 * to look them up and inject related memories via additionalContext.
 *
 * The in-process prefilter is the whole performance story: PostToolUse fires
 * dozens of times per turn, and the common case (a file already seen this
 * session) must cost only this hook's startup — never a CLI spawn.
 *
 * Ledger (append-only JSONL, race-safe under parallel tool calls):
 *   <project>/.claude/memory/ambient/<session-id>.jsonl
 *   { "t":"reset" }                                  written by memory-inject.cjs each turn
 *   { "t":"spawn", "entities":[...], "injected":b }  written here per spawn
 *
 * Off switch: MEMORY_PKG_AMBIENT_DISABLED=1.
 *
 * NEVER blocks; any error → exit 0 with no output.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AMBIENT_DIR = path.join(PROJECT_DIR, ".claude", "memory", "ambient");
const PER_TURN_CAP = 2;
const PER_SESSION_CAP = 8;
const SPAWN_TIMEOUT_MS = 5000;

// ===== BEGIN GENERATED-PARITY =================================================
// Vendored copy of src/entities/extract.ts. A CI parity test
// (test/ambientParity.test.ts) asserts this stays byte-equivalent in behavior
// to the package extractor over a fixture corpus — drift fails the build, not
// production. Keep edits in sync with src/entities/extract.ts.
const RE_BACKTICK = /`([^`\n]{2,64})`/g;
const RE_DOUBLE_QUOTE = /"([^"\n]{3,64})"/g;
const RE_FILE = /\b([\w./-]*[a-zA-Z][\w./-]*\.[a-zA-Z]{2,5})\b/g;
const RE_CAMEL = /\b([A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)\b/g;
const RE_SNAKE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const REGEXES = [RE_BACKTICK, RE_DOUBLE_QUOTE, RE_FILE, RE_CAMEL, RE_SNAKE];
const CODE_SYNTAX_CHARS = /[:=<>?(){}\[\]\\|+*]/;
const PROSE_CHARS = /[—–'’]/;
const STOPWORDS = new Set([
  "true", "false", "null", "undefined", "none", "todo", "note", "readme",
  "license", "package", "config", "index", "main", "utils", "helper",
  "example", "sample", "default", "this", "that", "these", "those",
  "the", "and", "for", "with", "from", "into", "your", "yours",
  "onedrive", "appdata", "users", "desktop", "code", "programfiles",
  "roaming", "documents", "downloads", "local", "temp", "home",
  "assistant_text", "user_prompt", "tool_call", "tool_result", "turn_rationale",
  "assistant_thinking",
]);
function stripAbsolutePaths(text) {
  return text
    .replace(/[A-Za-z]:[\\/](?:[^\s`"'\n\\/]+[\\/])+/g, "")
    .replace(/\/[a-zA-Z]\/Users\/[^\s`"'\n/]+\//g, "")
    .replace(/\/home\/[^\s`"'\n/]+\//g, "");
}
function extractEntities(text) {
  if (!text) return [];
  const corpus = stripAbsolutePaths(text);
  const out = new Set();
  for (const re of REGEXES) {
    for (const m of corpus.matchAll(re)) {
      const raw = (m[1] || "").trim();
      if (raw.length < 3 || raw.length > 40) continue;
      if (STOPWORDS.has(raw.toLowerCase())) continue;
      if (CODE_SYNTAX_CHARS.test(raw)) continue;
      if (PROSE_CHARS.test(raw)) continue;
      if ((raw.match(/\s+/g) || []).length > 1) continue;
      if (!/[a-z]/.test(raw)) continue;
      out.add(raw);
    }
  }
  return [...out];
}
function normalizeEntity(s) {
  return s.trim().toLowerCase();
}
// ===== END GENERATED-PARITY ===================================================

function resolveCliPath() {
  const candidates = [
    process.env.MEMORY_PKG_CLI_PATH,
    path.join(PROJECT_DIR, "node_modules", "@sylphie-labs", "memory-pkg", "dist", "cli", "memory-pkg.js"),
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

// Entity sources in tool input: the values the agent chose, never the keys.
function entitiesFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const texts = [];
  for (const k of ["pattern", "query", "path", "file_path", "prompt", "description"]) {
    if (typeof toolInput[k] === "string") texts.push(toolInput[k]);
  }
  const out = new Set(extractEntities(texts.join(" ")));
  // A Read's basename is itself a strong entity even if the regex misses it.
  for (const k of ["path", "file_path"]) {
    const v = toolInput[k];
    if (typeof v === "string" && v) {
      const base = v.split(/[\\/]/).pop();
      if (base && /\.[a-zA-Z]{2,5}$/.test(base)) out.add(base);
    }
  }
  return [...out];
}

function readLedger(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function main(input) {
  if (process.env.MEMORY_PKG_AMBIENT_DISABLED) return null;
  let payload;
  try { payload = JSON.parse(input || "{}"); } catch { return null; }

  const sessionId = payload.session_id;
  if (!sessionId) return null;

  const norms = [...new Set(entitiesFromToolInput(payload.tool_input).map(normalizeEntity))];
  if (norms.length === 0) return null;

  const ledgerFile = path.join(AMBIENT_DIR, `${sessionId}.jsonl`);
  const lines = readLedger(ledgerFile);

  // Dedup + caps from the append-only log.
  const seen = new Set();
  let lastReset = -1;
  const spawnLines = [];
  lines.forEach((e, i) => {
    if (e.t === "reset") lastReset = i;
    else if (e.t === "spawn") {
      spawnLines.push({ idx: i, injected: !!e.injected });
      for (const en of e.entities || []) seen.add(en);
    }
  });
  const sessionInjected = spawnLines.filter((s) => s.injected).length;
  const turnInjected = spawnLines.filter((s) => s.injected && s.idx > lastReset).length;
  if (turnInjected >= PER_TURN_CAP || sessionInjected >= PER_SESSION_CAP) return null;

  const fresh = norms.filter((n) => !seen.has(n));
  if (fresh.length === 0) return null; // common case: nothing new — no spawn

  const cli = resolveCliPath();
  if (!cli) return null;

  let text = "";
  let injected = false;
  try {
    const res = spawnSync(
      process.execPath,
      ["--enable-source-maps", cli, "ambient", "-"],
      { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, cwd: PROJECT_DIR, input: JSON.stringify({ session_id: sessionId, entities: fresh }) },
    );
    if (res.status === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout);
      text = typeof parsed.text === "string" ? parsed.text : "";
      injected = !!parsed.injected;
    }
  } catch {
    // fail open; mark fresh entities seen so we don't spawn-storm on them
  }

  // Append the probe so these entities aren't re-spawned this session.
  try {
    fs.mkdirSync(AMBIENT_DIR, { recursive: true });
    fs.appendFileSync(ledgerFile, JSON.stringify({ t: "spawn", entities: fresh, injected }) + "\n", "utf8");
  } catch {
    // best effort
  }

  if (!text) return null;
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
  };
}

// Exports for the parity test; run the hook only when executed directly.
module.exports = { extractEntities, normalizeEntity, entitiesFromToolInput };

if (require.main === module) {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => {
    let out = null;
    try { out = main(buf); } catch { out = null; }
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}
