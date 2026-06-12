/**
 * ledger-prune (deep) -- Delete injection ledger sidecar files older than 7
 * days. The ledgers only drive the same-session Stop rate hook; once a session
 * is long over, its ledger (and its .requested marker) are dead weight.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Processor, ProcessorContext, ProcessorResult } from '../types.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const ledgerPruneProcessor: Processor = {
  name: 'ledger-prune',
  cadence: 'deep',
  async run(ctx: ProcessorContext): Promise<ProcessorResult> {
    const dir = path.join(ctx.bufferDir, 'injections');
    let removed = 0;
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return { processed: 0, skipped: 0, exhausted: true };
    }
    const now = Date.now();
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        if (now - fs.statSync(full).mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // skip
      }
    }
    ctx.log(`ledger-prune removed=${removed}`);
    return { processed: removed, skipped: 0, exhausted: true };
  },
};
