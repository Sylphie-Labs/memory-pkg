/**
 * transcript.ts -- Test helpers for building Claude Code JSONL transcripts.
 *
 * Produces content blocks and full transcript lines matching the real Claude
 * Code transcript format consumed by template/.claude/hooks/memory-capture.cjs:
 * each line is a top-level object { type, uuid, timestamp, sessionId, message }
 * where message = { role, content: ContentBlock[] }.
 *
 * Use userLine/assistantLine to tag each line's role explicitly — do NOT rely on
 * block-shape heuristics, since both user and assistant turns can contain a lone
 * text block.
 */

export interface ContentBlock {
  type: string;
  [k: string]: unknown;
}

export interface Turn {
  type: 'user' | 'assistant';
  uuid: string;
  timestamp: string;
  sessionId: string;
  message: { role: string; content: ContentBlock[] };
}

export type TranscriptLine = { role: 'user' | 'assistant'; content: ContentBlock[] };

/** Tag one transcript line as a user turn. */
export const userLine = (...content: ContentBlock[]): TranscriptLine => ({
  role: 'user',
  content,
});

/** Tag one transcript line as an assistant turn. */
export const assistantLine = (...content: ContentBlock[]): TranscriptLine => ({
  role: 'assistant',
  content,
});

/**
 * A user prompt content block (type:'text', text field).
 */
export function userPrompt(
  text: string,
  opts?: { uuid?: string; ts?: string },
): ContentBlock {
  const block: ContentBlock = { type: 'text', text };
  if (opts?.uuid !== undefined) block.uuid = opts.uuid;
  if (opts?.ts !== undefined) block.ts = opts.ts;
  return block;
}

export function assistantText(text: string, opts?: { uuid?: string }): ContentBlock {
  const block: ContentBlock = { type: 'text', text };
  if (opts?.uuid !== undefined) block.uuid = opts.uuid;
  return block;
}

export function thinking(text: string): ContentBlock {
  return { type: 'thinking', thinking: text };
}

export function toolUse(
  name: string,
  input: Record<string, unknown>,
  id?: string,
): ContentBlock {
  return { type: 'tool_use', id: id ?? 'test-tool-0001', name, input };
}

export function toolResult(toolUseId: string, content: string): ContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content };
}

const BASE_TS_MS = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Build a JSONL string (one JSON object per line) matching the real Claude Code
 * transcript format. Each element of `lines` is a TranscriptLine built with
 * userLine() or assistantLine(); its role is used directly for both the top-level
 * `type` field and `message.role`. uuid auto-increments as 'test-uuid-0001',
 * 'test-uuid-0002', ...; timestamp auto-increments 1s from 2026-01-01T00:00:00Z.
 */
export function makeTranscript(sessionId: string, lines: TranscriptLine[]): string {
  return (
    lines
      .map((line, i) => {
        const seq = String(i + 1).padStart(4, '0');
        const uuid = `test-uuid-${seq}`;
        const timestamp = new Date(BASE_TS_MS + i * 1000).toISOString();
        const turn: Turn = {
          type: line.role,
          uuid,
          timestamp,
          sessionId,
          message: { role: line.role, content: line.content },
        };
        return JSON.stringify(turn);
      })
      .join('\n') + '\n'
  );
}
