/**
 * orphan-sweep (deep) -- Recover transcript tails that the per-session byte
 * cursor never advanced over.
 *
 * The capture hook only advances .claude/memory/cursors/<session>.json when a
 * Stop hook fires. If a terminal is killed mid-session, every event past the
 * last cursor is stranded — even though the transcript JSONL is intact on disk
 * (bug B2). This deep-pass processor compares each transcript's size against
 * its stored cursor and back-captures the delta into buffer.jsonl, where
 * ingest-flush (running next in the deep pass) lands it.
 *
 * Safety:
 *   - mtime gate: only sweep transcripts idle > MIN_IDLE_MS, so a live session
 *     (whose own Stop hook owns the cursor) is never touched.
 *   - cursor advance + the (session_id, transcript_uuid, ts) unique index make
 *     double-capture a no-op even if a sweep and a live hook overlap.
 *   - Kill switch: MEMORY_PKG_SWEEP_DISABLED=1.
 *
 * Reuses the capture hook's pure processTranscript()/sanitizeProjectPath() so
 * parsing stays identical to the live path; the buffer/cursor writes are done
 * here against ctx.bufferDir so the processor is hermetic and testable.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const MIN_IDLE_MS = 10 * 60 * 1000; // don't sweep a transcript touched in the last 10 min

interface CaptureModule {
  processTranscript(
    transcriptPath: string,
    projectPath: string,
    cursor: { byteOffset: number },
  ): { events: Array<Record<string, unknown>>; newOffset: number };
  sanitizeProjectPath(p: string): string;
}

/**
 * Resolve the bundled memory-capture.cjs (template/.claude/hooks) relative to
 * the compiled dist/ layout, and require it for its pure exports. Returns null
 * if it can't be located/loaded — the sweep then no-ops.
 */
function loadCaptureModule(): CaptureModule | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/consolidate/processors -> package root is three up.
    const pkgRoot = path.resolve(here, '..', '..', '..');
    const cjsPath = path.join(pkgRoot, 'template', '.claude', 'hooks', 'memory-capture.cjs');
    if (!fs.existsSync(cjsPath)) return null;
    const require = createRequire(import.meta.url);
    return require(cjsPath) as CaptureModule;
  } catch {
    return null;
  }
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Directory holding the session transcript JSONLs. Defaults to the Claude Code
 * convention ~/.claude/projects/<sanitized-project-path>/. Overridable via
 * MEMORY_PKG_TRANSCRIPT_DIR (used by tests, and as an escape hatch).
 */
function transcriptDir(capture: CaptureModule): string {
  const override = process.env.MEMORY_PKG_TRANSCRIPT_DIR;
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'projects', capture.sanitizeProjectPath(projectDir()));
}

function readCursor(cursorDir: string, sessionId: string): { byteOffset: number } {
  const file = path.join(cursorDir, `${sessionId}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { byteOffset?: unknown };
    return { byteOffset: typeof parsed.byteOffset === 'number' ? parsed.byteOffset : 0 };
  } catch {
    return { byteOffset: 0 };
  }
}

function writeCursor(cursorDir: string, sessionId: string, byteOffset: number): void {
  if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });
  fs.writeFileSync(path.join(cursorDir, `${sessionId}.json`), JSON.stringify({ byteOffset }), 'utf8');
}

function appendBuffer(bufferDir: string, events: Array<Record<string, unknown>>): void {
  if (events.length === 0) return;
  if (!fs.existsSync(bufferDir)) fs.mkdirSync(bufferDir, { recursive: true });
  fs.appendFileSync(
    path.join(bufferDir, 'buffer.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

export const orphanSweepProcessor: Processor = {
  name: 'orphan-sweep',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    if (process.env.MEMORY_PKG_SWEEP_DISABLED) {
      ctx.log('orphan-sweep disabled via MEMORY_PKG_SWEEP_DISABLED');
      return { processed: 0, skipped: 0, exhausted: true };
    }

    const capture = loadCaptureModule();
    if (!capture) {
      ctx.log('orphan-sweep: capture module unavailable; skipping');
      return { processed: 0, skipped: 0, exhausted: true };
    }

    const dir = transcriptDir(capture);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      ctx.log(`orphan-sweep: no transcript dir at ${dir}`);
      return { processed: 0, skipped: 0, exhausted: true };
    }

    const cursorDir = path.join(ctx.bufferDir, 'cursors');
    const pdir = projectDir();
    const now = Date.now();
    let processed = 0;
    let skipped = 0;
    let exhausted = true;

    for (const file of entries) {
      if (Date.now() >= ctx.deadline) {
        exhausted = false;
        break;
      }
      const sessionId = file.replace(/\.jsonl$/, '');
      const full = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      // Skip live sessions — their own Stop hook owns the cursor.
      if (now - stat.mtimeMs < MIN_IDLE_MS) {
        skipped++;
        continue;
      }
      const cursor = readCursor(cursorDir, sessionId);
      if (cursor.byteOffset >= stat.size) {
        skipped++;
        continue; // already up to date
      }

      try {
        const { events, newOffset } = capture.processTranscript(full, pdir, cursor);
        appendBuffer(ctx.bufferDir, events);
        writeCursor(cursorDir, sessionId, newOffset);
        if (events.length > 0) {
          processed++;
          ctx.log(`orphan-sweep recovered ${events.length} event(s) from ${sessionId}`);
        }
      } catch (err) {
        ctx.log(`orphan-sweep error on ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { processed, skipped, exhausted };
  },
};
