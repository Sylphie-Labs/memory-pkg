import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/rationale/synthesize.js';

// Turn is not exported from synthesize.ts; buildPrompt only reads a structural
// subset (session_id + events[]), so we build a matching shape and pass it.
interface TurnEventLike {
  event_id: string;
  ts: string;
  event_type: string;
  tool_name: string | null;
  file_path: string | null;
  summary: string | null;
  payload: unknown;
}
interface TurnLike {
  session_id: string;
  startTs: string;
  endTs: string | null;
  userPromptId: string;
  events: TurnEventLike[];
}

function userPromptEvent(over: Partial<TurnEventLike> = {}): TurnEventLike {
  return {
    event_id: 'up1',
    ts: '2026-01-01T00:00:00.000Z',
    event_type: 'user_prompt',
    tool_name: null,
    file_path: null,
    summary: null,
    payload: null,
    ...over,
  };
}

function makeTurn(events: TurnEventLike[]): TurnLike {
  return {
    session_id: 'S1',
    startTs: '2026-01-01T00:00:00.000Z',
    endTs: null,
    userPromptId: 'up1',
    events,
  };
}

// buildPrompt is typed against the internal Turn; the structural shape matches.
const build = (t: TurnLike): string => buildPrompt(t as unknown as Parameters<typeof buildPrompt>[0]);

describe('buildPrompt', () => {
  it('includes the user prompt text from payload.text', () => {
    const out = build(
      makeTurn([userPromptEvent({ payload: { text: 'please refactor the parser' } })]),
    );
    expect(out).toContain('please refactor the parser');
  });

  it('falls back to summary when payload.text is null', () => {
    const out = build(
      makeTurn([userPromptEvent({ payload: null, summary: 'summary-of-the-ask' })]),
    );
    expect(out).toContain('summary-of-the-ask');
  });

  it('renders a fallback when there is no visible assistant text', () => {
    // Turn with only a user_prompt -> no assistant_text chunks.
    const out = build(makeTurn([userPromptEvent({ payload: { text: 'hi' } })]));
    expect(out).toContain('(no visible text');
  });

  it('slices the user prompt text to the 4000-char cap', () => {
    const huge = 'q'.repeat(8000);
    const out = build(makeTurn([userPromptEvent({ payload: { text: huge } })]));
    // The user section must not carry more than 4000 of the q's.
    const qRun = out.match(/q+/)?.[0] ?? '';
    expect(qRun.length).toBe(4000);
  });
});
