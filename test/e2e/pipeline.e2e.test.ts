/**
 * pipeline.e2e.test.ts -- T1, the cross-session round-trip end-to-end test.
 *
 * Exercises the whole memory pipeline against a real TimescaleDB:
 *   transcript JSONL  ->  processTranscript (capture hook)
 *                     ->  appendEvents (local buffer)
 *                     ->  ingest (embed + bulk insert)
 *                     ->  generateInjection (retrieve + render)
 *
 * Two sessions are simulated:
 *   - Session A: a refactor session that edited the auth middleware to use JWT.
 *   - Session B: a fresh session asking about JWT; it should surface A's events.
 *
 * Self-exclusion is also checked: injecting for session A must NOT surface A's
 * own events (excludeSelf is on by default).
 *
 * Requires a live TimescaleDB. If createTestDb() throws (no DB reachable), the
 * whole suite is skipped gracefully rather than failing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createTestDb, withEnvAsync, type TestDb } from '../helpers/db.js';
import {
  makeTranscript,
  userLine,
  assistantLine,
  userPrompt,
  assistantText,
  toolUse,
  toolResult,
} from '../helpers/transcript.js';
import { ingest } from '../../src/ingest/ingester.js';
import { generateInjection } from '../../src/inject/generate.js';

const require = createRequire(import.meta.url);

interface CaptureHook {
  processTranscript: (
    transcriptPath: string,
    projectPath: string,
    cursor: { byteOffset: number },
  ) => { events: Array<Record<string, unknown>>; newOffset: number };
  appendEvents: (events: Array<Record<string, unknown>>) => void;
}

let db: TestDb | undefined;
let dbAvailable = false;
let tmpDir = '';
let bufferDir = '';
let hook: CaptureHook;

beforeAll(async () => {
  // A scratch project dir; the capture hook computes its buffer path from
  // CLAUDE_PROJECT_DIR at module-load time, so set it BEFORE requiring the hook.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pkg-e2e-'));
  bufferDir = path.join(tmpDir, '.claude', 'memory');
  process.env.CLAUDE_PROJECT_DIR = tmpDir;

  hook = require('../../template/.claude/hooks/memory-capture.cjs') as CaptureHook;

  try {
    db = await createTestDb();
    dbAvailable = true;
  } catch (err) {
    // No reachable TimescaleDB -- skip the whole suite gracefully.
    process.stderr.write(
      `[pipeline.e2e] skipping: test DB unavailable (${err instanceof Error ? err.message : String(err)})\n`,
    );
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (db) await db.drop();
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('E2E T1: cross-session round trip', () => {
  it('captures session A, ingests it, and surfaces it for session B (not A)', async (ctx) => {
    if (!dbAvailable || !db) return ctx.skip();

    // ---- 1. Build session A's transcript -------------------------------------
    // Model each turn as a separate line:
    //   line 1: user prompt                          -> 1 event  (user_prompt)
    //   line 2: assistant text + tool_use (one line) -> 2 events (assistant_text, tool_call)
    //                                                   uuids suffixed :0 / :1
    //   line 3: user-side tool_result                -> 1 event  (tool_result)
    const transcript = makeTranscript('sess-a', [
      userLine(userPrompt('switch the auth middleware to JWT validation')),
      assistantLine(
        assistantText(
          'I will refactor passport-local to jsonwebtoken in src/auth/middleware.ts',
        ),
        toolUse(
          'Edit',
          {
            file_path: 'src/auth/middleware.ts',
            old_string: 'passport.use(new LocalStrategy(...))',
            new_string: 'jwt.verify(token, secret)',
          },
          'tool-use-id-1',
        ),
      ),
      userLine(toolResult('tool-use-id-1', 'File edited successfully')),
    ]);

    const transcriptPath = path.join(tmpDir, 'transcript-sess-a.jsonl');
    fs.writeFileSync(transcriptPath, transcript, 'utf8');

    // ---- 2. Capture: processTranscript ---------------------------------------
    const { events, newOffset } = hook.processTranscript(transcriptPath, tmpDir, {
      byteOffset: 0,
    });

    expect(events).toHaveLength(4);
    expect(events.map((e) => e.event_type)).toEqual([
      'user_prompt',
      'assistant_text',
      'tool_call',
      'tool_result',
    ]);
    // The assistant_text + tool_call share line 2's uuid and so are suffixed.
    expect(events[1].transcript_uuid).toBe('test-uuid-0002:0');
    expect(events[2].transcript_uuid).toBe('test-uuid-0002:1');
    // Single-event lines keep their bare uuid.
    expect(events[0].transcript_uuid).toBe('test-uuid-0001');
    expect(events[3].transcript_uuid).toBe('test-uuid-0003');
    expect(newOffset).toBe(Buffer.byteLength(transcript, 'utf8'));

    // ---- 3. Buffer: appendEvents ---------------------------------------------
    hook.appendEvents(events);
    const bufferFile = path.join(bufferDir, 'buffer.jsonl');
    expect(fs.existsSync(bufferFile)).toBe(true);
    const bufferLines = fs
      .readFileSync(bufferFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(bufferLines).toHaveLength(4);

    // ---- 4. Ingest -----------------------------------------------------------
    // MEMORY_PKG_EMBED_FAKE=1 (from vitest.integration.config.ts env) keeps the
    // ingester's embedMany() on the deterministic fake embedder -- no ONNX load.
    const result = await withEnvAsync(db!.env, async () => ingest({ bufferDir }));
    expect(result.inserted).toBe(4);
    // Buffer is consumed (rotated + deleted) on a successful ingest.
    expect(fs.existsSync(bufferFile)).toBe(false);

    // ---- 5. Inject for session B (should surface A) --------------------------
    const injectedForB = await withEnvAsync(db!.env, async () =>
      generateInjection({
        query: 'JWT auth middleware refactor',
        currentSessionId: 'sess-b',
      }),
    );

    expect(injectedForB).toMatch(/<memory-context>[\s\S]*<\/memory-context>/);
    expect(
      injectedForB.includes('jsonwebtoken') ||
        injectedForB.includes('src/auth/middleware.ts'),
    ).toBe(true);
    // tool_result rows are never rendered into the injected block.
    expect(injectedForB).not.toContain('File edited successfully');

    // ---- 6. Self-exclusion: inject for session A (must NOT surface A) ---------
    const injectedForA = await withEnvAsync(db!.env, async () =>
      generateInjection({
        query: 'JWT auth middleware refactor',
        currentSessionId: 'sess-a',
      }),
    );

    // excludeSelf is on by default, so none of A's just-inserted content leaks.
    expect(injectedForA.includes('jsonwebtoken')).toBe(false);
    expect(injectedForA.includes('src/auth/middleware.ts')).toBe(false);
    expect(injectedForA.includes('passport')).toBe(false);
  });
});
