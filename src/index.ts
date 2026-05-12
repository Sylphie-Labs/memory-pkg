/**
 * @anthrorg-infra/memory-pkg — public library entry.
 *
 * Most consumers use this package via the CLI, the MCP server, or the
 * .claude hooks installed by `memory-pkg setup`. This entry exists for
 * programmatic consumers (custom tooling, tests, scripts) that want to
 * invoke individual pieces of the pipeline from their own Node code.
 */

export { initSchema } from './schema.js';
export { ingest } from './ingest/ingester.js';
export { generateInjection } from './inject/generate.js';
export type { GenerateInjectionOptions } from './inject/generate.js';

export { synthesizeRationales } from './rationale/synthesize.js';

export { deriveSubsystem, backfillSubsystems } from './subsystem.js';
export { embed, embedMany, toVectorLiteral, backfillEmbeddings, EMBED_DIM } from './embed.js';

export { handleSearchMemory } from './mcp-server/tools/searchMemory.js';
export type { SearchMemoryInput } from './mcp-server/tools/searchMemory.js';
export { handleGetMemoryContext } from './mcp-server/tools/getMemoryContext.js';
export type { GetMemoryContextInput } from './mcp-server/tools/getMemoryContext.js';
export { handleUnwindFromEvent } from './mcp-server/tools/unwindFromEvent.js';
export type { UnwindFromEventInput } from './mcp-server/tools/unwindFromEvent.js';
export { handleGetSessionTimeline } from './mcp-server/tools/getSessionTimeline.js';
export type { GetSessionTimelineInput } from './mcp-server/tools/getSessionTimeline.js';

export { getPool, closePool, runQuery } from './timescale-client.js';
