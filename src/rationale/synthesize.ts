/**
 * synthesize.ts -- Post-ingest enrichment that synthesizes a 2–3 sentence
 * "why" rationale per turn and inserts it as a turn_rationale event.
 *
 * A turn is the set of events between two consecutive user_prompts in the same
 * session (or from session start to the first user_prompt's successor chain,
 * and from the last user_prompt to session end).
 *
 * Shells out to the local `claude` CLI (which uses the user's authenticated
 * Max account via the terminal) — no API key needed, no external fetch.
 *
 * Idempotent: skips turns that already have a turn_rationale event.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { runQuery } from '../timescale-client.js';
import { getModelFor } from '../config.js';

const CLAUDE_BIN = process.env.MEMORY_PKG_CLAUDE_BIN ?? 'claude';

// Project name for the rationale prompt, derived from the consumer repo
// directory. CLAUDE_PROJECT_DIR is set by the Claude Code hook; fall back
// to the current working directory for direct CLI runs.
const PROJECT_NAME = path.basename(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

interface TurnEvent {
  event_id: string;
  ts: string;
  event_type: string;
  tool_name: string | null;
  file_path: string | null;
  summary: string | null;
  payload: unknown;
}

interface UserPromptRow {
  event_id: string;
  ts: string;
  session_id: string;
}

interface Turn {
  session_id: string;
  startTs: string;
  endTs: string | null;
  userPromptId: string;
  events: TurnEvent[];
}

async function findTurnsWithoutRationale(
  sessionId?: string,
  limit = 20
): Promise<Turn[]> {
  const filters: string[] = [`event_type = 'user_prompt'`];
  const params: unknown[] = [];
  let i = 1;

  if (sessionId) {
    filters.push(`session_id = $${i++}`);
    params.push(sessionId);
  }
  params.push(limit);

  // Find user_prompts that don't already have a turn_rationale immediately after.
  const prompts = await runQuery<UserPromptRow>(
    `
    SELECT p.event_id, p.ts, p.session_id
    FROM memory_events p
    WHERE ${filters.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM memory_events r
        WHERE r.session_id = p.session_id
          AND r.event_type = 'turn_rationale'
          AND r.payload ->> 'source_user_prompt_id' = p.event_id::text
      )
    ORDER BY p.ts DESC
    LIMIT $${i}
    `,
    params
  );

  const turns: Turn[] = [];
  for (const p of prompts) {
    // End of turn = next user_prompt in same session, or now.
    const nextRow = await runQuery<{ ts: string }>(
      `SELECT ts FROM memory_events
       WHERE session_id = $1 AND event_type = 'user_prompt' AND ts > $2::timestamptz
       ORDER BY ts ASC LIMIT 1`,
      [p.session_id, p.ts]
    );
    const endTs = nextRow.length > 0 ? nextRow[0].ts : null;

    const events = endTs
      ? await runQuery<TurnEvent>(
          `SELECT event_id, ts, event_type, tool_name, file_path, summary, payload
           FROM memory_events
           WHERE session_id = $1 AND ts >= $2::timestamptz AND ts < $3::timestamptz
           ORDER BY ts ASC`,
          [p.session_id, p.ts, endTs]
        )
      : await runQuery<TurnEvent>(
          `SELECT event_id, ts, event_type, tool_name, file_path, summary, payload
           FROM memory_events
           WHERE session_id = $1 AND ts >= $2::timestamptz
           ORDER BY ts ASC`,
          [p.session_id, p.ts]
        );

    turns.push({
      session_id: p.session_id,
      startTs: p.ts,
      endTs,
      userPromptId: p.event_id,
      events,
    });
  }

  return turns;
}

export function buildPrompt(turn: Turn): string {
  const userPrompt = turn.events.find((e) => e.event_type === 'user_prompt');
  const userText = userPrompt && (userPrompt.payload as { text?: string })?.text
    ? (userPrompt.payload as { text?: string }).text!
    : userPrompt?.summary ?? '';

  const assistantChunks = turn.events
    .filter((e) => e.event_type === 'assistant_text')
    .map((e) => (e.payload as { text?: string })?.text ?? e.summary ?? '')
    .join('\n\n');

  const toolSummaries = turn.events
    .filter((e) => e.event_type === 'tool_call')
    .map((e) => `- ${e.summary ?? e.tool_name ?? 'unknown'}`)
    .join('\n');

  return `A developer is working with Claude Code on the "${PROJECT_NAME}" project.

## User prompt
${userText.slice(0, 4000)}

## Claude's visible reply (assistant text)
${assistantChunks.slice(0, 6000) || '(no visible text — only tool calls)'}

## Tool calls Claude made
${toolSummaries || '(none)'}

## Task
In 2–3 sentences, write a rationale for this turn — the "why" behind Claude's approach. Explain:
1. What goal Claude was pursuing
2. What approach Claude chose and why (vs alternatives, if the reply mentioned any)
3. Any constraint or prior decision that drove the choice

Write in present tense, first-person plural ("we"), as if preparing a note for a future session to find via fuzzy search. Do not preamble. Output only the 2–3 sentences.`;
}

/**
 * Invokes the local `claude` CLI in print mode with the prompt on stdin.
 * Uses the user's authenticated Max account — no API key involved.
 */
async function callClaudeCli(prompt: string, timeoutMs = 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // `-p` = print (one-shot, non-interactive). `--model` selects Haiku.
    // Prompt passes via stdin so we avoid shell-quoting issues with multi-line content.
    const proc = spawn(CLAUDE_BIN, ['-p', '--model', getModelFor('rationale')], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
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
      clearTimeout(timeout);
      reject(new Error(`failed to spawn ${CLAUDE_BIN}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}. stderr: ${stderr.slice(0, 500)}`));
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

async function insertRationale(turn: Turn, rationale: string): Promise<void> {
  const transcriptUuid = `rationale:${turn.session_id}:${turn.userPromptId}`;
  const ts = turn.endTs ?? new Date().toISOString();
  const searchText = ['turn_rationale', rationale].join(' ').slice(0, 2000);

  await runQuery(
    `INSERT INTO memory_events
       (ts, session_id, event_type, summary, search_text, payload, transcript_uuid)
     VALUES ($1::timestamptz, $2, 'turn_rationale', $3, $4, $5::jsonb, $6)
     ON CONFLICT DO NOTHING`,
    [
      ts,
      turn.session_id,
      rationale.slice(0, 300),
      searchText,
      JSON.stringify({
        rationale,
        source_user_prompt_id: turn.userPromptId,
        model: getModelFor('rationale'),
        synthesized_at: new Date().toISOString(),
      }),
      transcriptUuid,
    ]
  );
}

export async function synthesizeRationales(opts: {
  sessionId?: string;
  limit?: number;
}): Promise<{ synthesized: number; skipped: number }> {
  const turns = await findTurnsWithoutRationale(opts.sessionId, opts.limit ?? 20);

  let synthesized = 0;
  let skipped = 0;

  for (const turn of turns) {
    // Skip empty turns (no assistant activity).
    const hasAssistant = turn.events.some(
      (e) => e.event_type === 'assistant_text' || e.event_type === 'tool_call'
    );
    if (!hasAssistant) {
      skipped++;
      continue;
    }

    const prompt = buildPrompt(turn);
    try {
      const rationale = await callClaudeCli(prompt);
      await insertRationale(turn, rationale);
      synthesized++;
      process.stdout.write(`[rationale] ok ${turn.session_id.slice(0, 8)}:${turn.userPromptId.slice(0, 8)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rationale] FAIL ${turn.session_id.slice(0, 8)}:${turn.userPromptId.slice(0, 8)} — ${msg}\n`);
      skipped++;
    }
  }

  return { synthesized, skipped };
}
