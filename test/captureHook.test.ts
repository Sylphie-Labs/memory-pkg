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
