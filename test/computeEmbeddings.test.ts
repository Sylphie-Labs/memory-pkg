import { describe, it, expect } from 'vitest';
import { computeEmbeddings, type BufferEvent } from '../src/ingest/ingester.js';

const ev = (over: Partial<BufferEvent>): BufferEvent => ({
  ts: '2026-01-01T00:00:00Z',
  session_id: 's',
  event_type: 'assistant_text',
  ...over,
});

describe('computeEmbeddings', () => {
  it('skips tool_result and empty-text events, embeds the rest', async () => {
    const events = [
      ev({ event_type: 'assistant_text', excerpt: 'hello world' }),
      ev({ event_type: 'tool_result', excerpt: 'big noisy tool output' }),
      ev({ event_type: 'user_prompt', excerpt: '   ' }), // whitespace-only
      ev({ event_type: 'user_prompt', summary: 'fallback summary' }), // excerpt absent -> summary
    ];
    const calls: string[][] = [];
    const fakeEmbed = async (texts: string[]): Promise<number[][]> => {
      calls.push(texts);
      return texts.map((_, i) => [i, i + 1]);
    };

    const out = await computeEmbeddings(events, fakeEmbed);

    // Only the two embeddable events are sent to the embedder, in order.
    expect(calls).toEqual([['hello world', 'fallback summary']]);
    expect(out[0]).toBe('[0,1]'); // first embeddable
    expect(out[1]).toBeNull(); // tool_result skipped
    expect(out[2]).toBeNull(); // whitespace-only skipped
    expect(out[3]).toBe('[1,2]'); // second embeddable
  });

  it('returns all-null and never throws when the embedder fails', async () => {
    const events = [ev({ excerpt: 'a' }), ev({ excerpt: 'b' })];
    const boom = async (): Promise<number[][]> => {
      throw new Error('model load failed');
    };
    const out = await computeEmbeddings(events, boom);
    expect(out).toEqual([null, null]);
  });

  it('does not call the embedder when there is nothing to embed', async () => {
    const events = [ev({ event_type: 'tool_result', excerpt: 'x' })];
    let called = false;
    const out = await computeEmbeddings(events, async (texts) => {
      called = true;
      return texts.map(() => [0]);
    });
    expect(called).toBe(false);
    expect(out).toEqual([null]);
  });
});
