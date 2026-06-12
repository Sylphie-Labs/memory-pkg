#!/usr/bin/env node
/**
 * memory-rate.cjs -- Stop hook that asks Claude to rate the long-term memories
 * it was injected this turn, so @sylphie-labs/memory-pkg can tune future recall.
 *
 * Zero dependencies, synchronous, NEVER touches the database. It reads the
 * injection ledger the inject path wrote:
 *   <project>/.claude/memory/injections/<session-id>.jsonl
 * and tracks which injections it has already asked about:
 *   <project>/.claude/memory/injections/<session-id>.requested
 *
 * If there are un-asked injections this turn (subject to sampling + a session
 * cap), it emits {"decision":"block","reason":...} re-quoting their summaries
 * and instructing Claude to call mcp__memory-pkg__rateMemoryInjections, then
 * finish. It honors stop_hook_active to avoid loops, and is a silent no-op when
 * there are no injections — which is most turns.
 *
 * Off switches:  MEMORY_PKG_RATING_DISABLED=1   |  MEMORY_PKG_RATE_SAMPLE=0
 */

const fs = require("fs");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const INJECTIONS_DIR = path.join(PROJECT_DIR, ".claude", "memory", "injections");
const SESSION_CAP = 8;
const REASON_CAP = 1200;

function readSample() {
  const raw = process.env.MEMORY_PKG_RATE_SAMPLE;
  if (raw === undefined) return 0.25;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function main(input) {
  if (process.env.MEMORY_PKG_RATING_DISABLED) return null;

  let payload;
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    return null;
  }
  // Already in a Stop-hook continuation (we blocked once) — don't loop.
  if (payload.stop_hook_active) return null;

  const sessionId = payload.session_id;
  if (!sessionId) return null;

  const ledgerFile = path.join(INJECTIONS_DIR, `${sessionId}.jsonl`);
  const requestedFile = path.join(INJECTIONS_DIR, `${sessionId}.requested`);

  const entries = [];
  for (const line of readLines(ledgerFile)) {
    try {
      const e = JSON.parse(line);
      if (e && e.injection_id && Array.isArray(e.items)) entries.push(e);
    } catch {
      // skip malformed
    }
  }
  if (entries.length === 0) return null;

  const requested = new Set(readLines(requestedFile));
  const pending = entries.filter((e) => !requested.has(e.injection_id));
  if (pending.length === 0) return null;

  const sample = readSample();
  const selected = [];
  const newlyRequested = [];
  let count = requested.size;

  for (const e of pending) {
    newlyRequested.push(e.injection_id); // considered exactly once, regardless of outcome
    if (count >= SESSION_CAP) continue;
    // Ambient injections are always rated; prompt-path injections are sampled.
    const keep = e.trigger === "ambient" || Math.random() < sample;
    if (keep) {
      selected.push(e);
      count++;
    }
  }

  // Mark everything we considered so we never re-ask, sampled or not.
  try {
    fs.mkdirSync(INJECTIONS_DIR, { recursive: true });
    fs.appendFileSync(requestedFile, newlyRequested.join("\n") + "\n", "utf8");
  } catch {
    // best effort
  }

  if (selected.length === 0) return null;

  const parts = [
    "Before finishing: rate the long-term memories you were injected this turn so future recall improves.",
    "Call mcp__memory-pkg__rateMemoryInjections once per injection below. For each event_id rate +1 (used/helpful), 0 (saw it, neutral/unused), or -1 (misleading/wrong). Be discriminating — rating everything +1 teaches nothing. Then finish your reply.",
    "",
  ];
  for (const e of selected) {
    parts.push(`injection ${e.injection_id}:`);
    for (const it of e.items) {
      parts.push(`  - ${it.item_id}: "${String(it.summary120 || "").slice(0, 100)}"`);
    }
  }
  let reason = parts.join("\n");
  if (reason.length > REASON_CAP) reason = reason.slice(0, REASON_CAP);

  return { decision: "block", reason };
}

let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  let out = null;
  try {
    out = main(buf);
  } catch {
    out = null; // never block on error
  }
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
