/**
 * processors/index.ts -- The ordered consolidation processor registry.
 *
 * The runner walks this list in order, skipping processors whose cadence
 * doesn't match the current run (tick vs deep). Order matters: ingest-flush
 * runs first so later processors see freshly-landed events. New phases append
 * here.
 */

import type { Processor } from '../types.js';
import { ingestFlushProcessor } from './ingest-flush.js';
import { rationaleProcessor } from './rationale.js';

export const PROCESSORS: Processor[] = [
  ingestFlushProcessor,
  rationaleProcessor,
];
