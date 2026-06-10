import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(import.meta.url);
const hook = require('../template/.claude/hooks/memory-capture.cjs') as {
  parseTranscriptLine: (line: string, projectPath: string) => Array<Record<string, unknown>>;
  processTranscript: (
    p: string,
    projectPath: string,
    cursor: { lastUuid: string | null; byteOffset: number },
  ) => { events: Array<Record<string, unknown>>; newOffset: number; lastUuid: string | null };
};

const assistantLine = JSON.stringify({
  type: 'assistant',
  uuid: 'U1',
  timestamp: '2026-01-01T00:00:00Z',
  sessionId: 'S',
  message: {
    content: [
      { type: 'text', text: 'doing the thing' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } },
    ],
  },
});

const userLine = JSON.stringify({
  type: 'user',
  uuid: 'U0',
  timestamp: '2026-01-01T00:00:00Z',
  sessionId: 'S',
  message: { content: 'please do the thing' },
});

describe('memory-capture parseTranscriptLine', () => {
  it('emits one event per content block, all sharing the line uuid', () => {
    const events = hook.parseTranscriptLine(assistantLine, '/proj');
    expect(events.map((e) => e.event_type)).toEqual(['assistant_text', 'tool_call', 'tool_call']);
    expect(events.every((e) => e.transcript_uuid === 'U1')).toBe(true);
  });
});

describe('memory-capture processTranscript (collision fix)', () => {
  const tmp = path.join(os.tmpdir(), `memory-pkg-capture-${process.pid}.jsonl`);
  afterAll(() => {
    try {
      fs.rmSync(tmp);
    } catch {
      /* ignore */
    }
  });

  it('suffixes transcript_uuid per block for multi-event lines, leaves single-event lines bare', () => {
    const content = userLine + '\n' + assistantLine + '\n';
    fs.writeFileSync(tmp, content, 'utf8');
    const { events, newOffset } = hook.processTranscript(tmp, '/proj', { lastUuid: null, byteOffset: 0 });

    expect(events).toHaveLength(4);
    expect(events[0].transcript_uuid).toBe('U0'); // single-event line keeps bare uuid
    expect(events[1].transcript_uuid).toBe('U1:0'); // multi-event line -> per-block suffix
    expect(events[2].transcript_uuid).toBe('U1:1');
    expect(events[3].transcript_uuid).toBe('U1:2');
    expect(new Set(events.map((e) => e.transcript_uuid)).size).toBe(4); // no collisions
    expect(newOffset).toBe(Buffer.byteLength(content, 'utf8'));
  });
});

describe('memory-capture payload and excerpt', () => {
  it('truncates tool_use input over 8000 chars into input_preview', () => {
    const bigArg = 'x'.repeat(9000);
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'U_big',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'S',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { content: bigArg } }],
      },
    });
    const [evt] = hook.parseTranscriptLine(line, '/proj');
    const payload = evt.payload as Record<string, unknown>;
    expect(payload.input_truncated).toBe(true);
    expect((payload.input_preview as string).length).toBe(8000);
    expect(payload.input).toBeUndefined();
  });

  it('keeps the original input object when JSON ≤ 8000 chars', () => {
    const input = { file_path: 'a.ts', pattern: 'foo' };
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'U_small',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'S',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input }] },
    });
    const [evt] = hook.parseTranscriptLine(line, '/proj');
    const payload = evt.payload as Record<string, unknown>;
    expect(payload.input).toEqual(input);
    expect(payload.input_truncated).toBeUndefined();
    expect(payload.input_preview).toBeUndefined();
  });

  // excerpt/search_text are derived in processTranscript (parseTranscriptLine
  // only carries _body), so these route a one-line transcript through it.
  function eventsFromLine(line: string, name: string): Array<Record<string, unknown>> {
    const tmp = path.join(os.tmpdir(), `memory-pkg-capture-${name}-${process.pid}.jsonl`);
    try {
      fs.writeFileSync(tmp, line + '\n', 'utf8');
      return hook.processTranscript(tmp, '/proj', { lastUuid: null, byteOffset: 0 }).events;
    } finally {
      try {
        fs.rmSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  it('extracts text from array-form tool_result content (not [object Object])', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'U_tr',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'S',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'the result body' }],
          },
        ],
      },
    });
    const [evt] = eventsFromLine(line, 'tr');
    expect(evt.event_type).toBe('tool_result');
    expect(evt.excerpt).toBe('the result body');
    expect(evt.excerpt as string).not.toContain('[object Object]');
    expect((evt.payload as Record<string, unknown>).content).toBe('the result body');
  });

  it('emits assistant_thinking with the thought text in the excerpt', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'U_think',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'S',
      message: { content: [{ type: 'thinking', thinking: 'let me reason about this' }] },
    });
    const [evt] = eventsFromLine(line, 'think');
    expect(evt.event_type).toBe('assistant_thinking');
    expect(evt.excerpt as string).toContain('let me reason about this');
  });

  it('does NOT consume an incomplete trailing line (no newline)', () => {
    const tmp2 = path.join(os.tmpdir(), `memory-pkg-capture-partial-${process.pid}.jsonl`);
    try {
      // First a complete line, then a partial line with no trailing newline.
      const complete = userLine + '\n';
      const content = complete + assistantLine; // assistantLine has no trailing \n
      fs.writeFileSync(tmp2, content, 'utf8');

      // Start the cursor past the already-consumed complete line so only the
      // partial line remains in the unread tail.
      const startOffset = Buffer.byteLength(complete, 'utf8');
      const { events, newOffset } = hook.processTranscript(tmp2, '/proj', {
        lastUuid: null,
        byteOffset: startOffset,
      });
      expect(events).toEqual([]);
      expect(newOffset).toBe(startOffset); // partial line NOT consumed
    } finally {
      try {
        fs.rmSync(tmp2);
      } catch {
        /* ignore */
      }
    }
  });

  it('suffixes transcript_uuid per block for a multi-block line (uuid:0, uuid:1)', () => {
    const tmp3 = path.join(os.tmpdir(), `memory-pkg-capture-multi-${process.pid}.jsonl`);
    try {
      // A user line carrying a text prompt + a tool_result block => 2 events.
      const multi = JSON.stringify({
        type: 'user',
        uuid: 'U_multi',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'S',
        message: {
          content: [
            { type: 'text', text: 'a prompt' },
            { type: 'tool_result', tool_use_id: 't1', content: 'a result' },
          ],
        },
      });
      const content = multi + '\n';
      fs.writeFileSync(tmp3, content, 'utf8');
      const { events } = hook.processTranscript(tmp3, '/proj', { lastUuid: null, byteOffset: 0 });
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.transcript_uuid)).toEqual(['U_multi:0', 'U_multi:1']);
    } finally {
      try {
        fs.rmSync(tmp3);
      } catch {
        /* ignore */
      }
    }
  });
});
