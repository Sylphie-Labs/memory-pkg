/**
 * processors/index.ts -- The ordered consolidation processor registry.
 *
 * The runner walks this list in order, skipping processors whose cadence
 * doesn't match the current run (tick vs deep). Order matters: ingest-flush
 * runs first so later processors see freshly-landed events. New phases append
 * here.
 */

import type { Processor } from '../types.js';
import { orphanSweepProcessor } from './orphan-sweep.js';
import { ingestFlushProcessor } from './ingest-flush.js';
import { embeddingBackfillProcessor } from './embedding-backfill.js';
import { rationaleProcessor } from './rationale.js';
import { rationaleBacklogProcessor } from './rationale-backlog.js';
import { entityLinkProcessor } from './entity-link.js';

// Order matters. orphan-sweep (deep) runs before ingest-flush so back-captured
// deltas are flushed in the same deep pass; rationale processors run after the
// flush so they see freshly-landed turns; entity-link runs last so it also
// links the rationale events just created. Cadence filtering in the runner
// decides which actually execute on a given tick vs deep run.
export const PROCESSORS: Processor[] = [
  orphanSweepProcessor, // deep
  ingestFlushProcessor, // both
  embeddingBackfillProcessor, // deep
  rationaleProcessor, // tick
  rationaleBacklogProcessor, // deep
  entityLinkProcessor, // both
];
