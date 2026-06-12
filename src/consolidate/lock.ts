/**
 * consolidate/lock.ts -- Named O_EXCL file lock, generalized from the
 * ingest.lock mechanism in src/ingest/ingester.ts.
 *
 * One consolidation run (tick or deep) holds .claude/memory/consolidate.lock
 * for its whole duration so overlapping Stop/SessionStart hooks can't run
 * derived-write processors concurrently (which would double Haiku spend and
 * race the anti-join queues). O_EXCL create is the atomic check-and-claim; a
 * lock older than staleMs is treated as a crashed run and broken.
 */

import * as fs from 'fs';
import * as path from 'path';

export function acquireNamedLock(dir: string, name: string, staleMs: number): boolean {
  const lockFile = path.join(dir, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs <= staleMs) return false; // live lock — back off
        fs.unlinkSync(lockFile); // stale — break it and retry the create
      } catch {
        // Lock vanished between open and stat/unlink — loop and retry create.
      }
    }
  }
  return false;
}

export function releaseNamedLock(dir: string, name: string): void {
  try {
    fs.unlinkSync(path.join(dir, name));
  } catch {
    // already gone — fine
  }
}
