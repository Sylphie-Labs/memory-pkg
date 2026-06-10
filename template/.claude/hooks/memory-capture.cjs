#!/usr/bin/env node
/**
 * memory-capture.cjs -- Stop hook that reads the Claude Code session transcript
 * tail and emits events to the local memory buffer for later ingestion into
 * TimescaleDB by @sylphie-labs/memory-pkg.
 *
 * Zero dependencies. Reads the official transcript JSONL at:
 *   ~/.claude/projects/<sanitized-project-path>/<session-id>.jsonl
 * and tracks a per-session cursor at:
 *   <project>/.claude/memory/cursors/<session-id>.json
 *
 * Event types emitted:
 *   user_prompt          user message text
 *   assistant_thinking   thinking blocks (what was reasoned in chat)
 *   assistant_text       assistant visible reply text
 *   tool_call            tool_use blocks from the assistant
 *   tool_result          tool_result blocks from the user side
 *
 * The hook NEVER blocks on errors — worst case the turn is skipped.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BUFFER_DIR = path.join(PROJECT_DIR, ".claude", "memory");
const BUFFER_FILE = path.join(BUFFER_DIR, "buffer.jsonl");
const CURSOR_DIR = path.join(BUFFER_DIR, "cursors");

function sanitizeProjectPath(p) {
  // Claude Code dir-naming convention: replace separators and colon with "-".
  return p.replace(/[:/\\]/g, "-");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function findTranscript(sessionId, projectDir) {
  const homeBase = path.join(os.homedir(), ".claude", "projects");
  const sanitized = sanitizeProjectPath(projectDir);
  const direct = path.join(homeBase, sanitized, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;

  // Fallback: scan all project dirs for the session file (useful if CLAUDE_PROJECT_DIR differs)
  try {
    const dirs = fs.readdirSync(homeBase, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(homeBase, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

function loadCursor(sessionId) {
  ensureDir(CURSOR_DIR);
  const file = path.join(CURSOR_DIR, `${sessionId}.json`);
  if (!fs.existsSync(file)) return { lastUuid: null, byteOffset: 0 };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { lastUuid: null, byteOffset: 0 };
  }
}

function saveCursor(sessionId, cursor) {
  ensureDir(CURSOR_DIR);
  const file = path.join(CURSOR_DIR, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(cursor), "utf8");
}

function appendEvents(events) {
  if (events.length === 0) return;
  ensureDir(BUFFER_DIR);
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(BUFFER_FILE, lines, "utf8");
}

function trunc(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function summarizeToolCall(toolName, input) {
  if (!input || typeof input !== "object") return toolName;
  const fields = [];
  if (typeof input.file_path === "string") fields.push(input.file_path);
  if (typeof input.path === "string") fields.push(input.path);
  if (typeof input.pattern === "string") fields.push(`"${trunc(input.pattern, 60)}"`);
  if (typeof input.command === "string") fields.push(`"${trunc(input.command, 80)}"`);
  if (typeof input.url === "string") fields.push(input.url);
  if (typeof input.query === "string") fields.push(`"${trunc(input.query, 80)}"`);
  if (typeof input.description === "string" && fields.length === 0) {
    fields.push(`"${trunc(input.description, 80)}"`);
  }
  return fields.length > 0 ? `${toolName} ${fields.join(" ")}` : toolName;
}

function extractFilePath(input) {
  if (!input || typeof input !== "object") return null;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return null;
}

function buildSearchText(event) {
  const parts = [];
  if (event.event_type) parts.push(event.event_type);
  if (event.tool_name) parts.push(event.tool_name);
  if (event.file_path) parts.push(event.file_path);
  if (event.summary) parts.push(event.summary);
  if (event._body) parts.push(trunc(event._body, 400));
  return parts.join(" ").slice(0, 2000);
}

/**
 * Self-contained excerpt for context injection. Different event types have
 * different ideal shapes.
 */
function buildExcerpt(event) {
  const body = event._body || "";
  switch (event.event_type) {
    case "user_prompt":
      return trunc(body, 500);
    case "assistant_text":
      return trunc(body, 500);
    case "assistant_thinking":
      return trunc(body, 500);
    case "tool_call": {
      const head = event.summary || event.tool_name || "tool_call";
      return head.length < 300 ? head : trunc(head, 300);
    }
    case "tool_result":
      return trunc(body, 300);
    case "turn_rationale":
      return trunc(body, 600);
    default:
      return trunc(body || event.summary || "", 300);
  }
}

function parseTranscriptLine(line, projectPath) {
  try {
    const entry = JSON.parse(line);
    if (!entry || !entry.type) return [];

    const base = {
      ts: entry.timestamp || new Date().toISOString(),
      session_id: entry.sessionId,
      project_path: projectPath,
      transcript_uuid: entry.uuid || null,
    };

    // user entries: text prompts and tool_result blocks
    if (entry.type === "user" && entry.message) {
      const content = entry.message.content;
      const events = [];

      if (typeof content === "string" && content.trim()) {
        events.push({
          ...base,
          event_type: "user_prompt",
          summary: trunc(content, 160),
          _body: content,
          payload: { text: content },
        });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && block.text) {
            events.push({
              ...base,
              event_type: "user_prompt",
              summary: trunc(block.text, 160),
              _body: block.text,
              payload: { text: block.text },
            });
          } else if (block.type === "tool_result") {
            const bodyText = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => (c && c.type === "text" ? c.text : "")).filter(Boolean).join("\n")
                : "";
            events.push({
              ...base,
              event_type: "tool_result",
              tool_use_id: block.tool_use_id || null,
              summary: `tool_result ${trunc(bodyText, 120)}`,
              _body: bodyText,
              payload: { is_error: !!block.is_error, content: bodyText.slice(0, 8000) },
            });
          }
        }
      }
      return events;
    }

    // assistant entries: thinking, text, tool_use
    if (entry.type === "assistant" && entry.message) {
      const content = entry.message.content;
      const events = [];
      if (!Array.isArray(content)) return events;

      for (const block of content) {
        if (!block || typeof block !== "object") continue;

        if (block.type === "thinking") {
          const text = block.thinking || "";
          if (text.trim()) {
            events.push({
              ...base,
              event_type: "assistant_thinking",
              summary: trunc(text, 160),
              _body: text,
              payload: { thinking: text },
            });
          }
        } else if (block.type === "text") {
          const text = block.text || "";
          if (text.trim()) {
            events.push({
              ...base,
              event_type: "assistant_text",
              summary: trunc(text, 160),
              _body: text,
              payload: { text },
            });
          }
        } else if (block.type === "tool_use") {
          const toolName = block.name || "unknown";
          const input = block.input || {};
          events.push({
            ...base,
            event_type: "tool_call",
            tool_name: toolName,
            tool_use_id: block.id || null,
            file_path: extractFilePath(input),
            summary: summarizeToolCall(toolName, input),
            _body: JSON.stringify(input).slice(0, 400),
            payload: { input },
          });
        }
      }
      return events;
    }

    return [];
  } catch {
    return [];
  }
}

function processTranscript(transcriptPath, projectPath, cursor) {
  const stat = fs.statSync(transcriptPath);
  const size = stat.size;

  // If file shrank (shouldn't happen, but defensive), reset.
  if (cursor.byteOffset > size) {
    cursor = { lastUuid: null, byteOffset: 0 };
  }

  if (cursor.byteOffset === size) {
    return { events: [], newOffset: size, lastUuid: cursor.lastUuid };
  }

  // Read from offset to end.
  const fd = fs.openSync(transcriptPath, "r");
  try {
    const toRead = size - cursor.byteOffset;
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, cursor.byteOffset);
    const chunk = buf.toString("utf8");

    // Split on newline; handle trailing partial line defensively by only
    // processing full lines (ending in \n). Partial last line is re-read next run.
    const lines = [];
    let consumed = 0;
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf("\n", i);
      if (nl === -1) break;
      lines.push(chunk.slice(i, nl));
      consumed = nl + 1;
      i = consumed;
    }
    const newOffset = cursor.byteOffset + Buffer.byteLength(chunk.slice(0, consumed), "utf8");

    const events = [];
    let lastUuid = cursor.lastUuid;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseTranscriptLine(trimmed, projectPath);
      parsed.forEach((evt, blockIdx) => {
        const { _body, ...clean } = evt;
        clean.search_text = buildSearchText(evt);
        clean.excerpt = buildExcerpt(evt);
        // A single transcript line can yield multiple events (e.g. assistant
        // text + several tool_use blocks, or parallel tool calls). They share
        // the line's uuid and timestamp, so without disambiguation they collide
        // on the (session_id, transcript_uuid, ts) unique index and all but one
        // are silently dropped by ON CONFLICT DO NOTHING. Suffix the block index
        // for multi-event lines; single-event lines keep the bare uuid to remain
        // backward-compatible with rows already ingested under the old scheme.
        if (clean.transcript_uuid && parsed.length > 1) {
          clean.transcript_uuid = `${clean.transcript_uuid}:${blockIdx}`;
        }
        events.push(clean);
        if (clean.transcript_uuid) lastUuid = clean.transcript_uuid;
      });
    }

    return { events, newOffset, lastUuid };
  } finally {
    fs.closeSync(fd);
  }
}

// ------------ main ------------

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const sessionId = payload.session_id;
    if (!sessionId) return process.exit(0);

    const transcript = findTranscript(sessionId, PROJECT_DIR);
    if (!transcript) return process.exit(0);

    const cursor = loadCursor(sessionId);
    const { events, newOffset, lastUuid } = processTranscript(transcript, PROJECT_DIR, cursor);

    if (events.length > 0) {
      appendEvents(events);
    }
    saveCursor(sessionId, { lastUuid, byteOffset: newOffset });
  } catch {
    // Never block.
  }
  process.exit(0);
});
