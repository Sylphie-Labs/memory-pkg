#!/usr/bin/env node
/**
 * index.ts -- MCP server entry point for @sylphie-labs/memory-pkg.
 *
 * Exposes long-term session memory to Claude Code via stdio:
 *   searchMemory         — fuzzy text match across event log
 *   getMemoryContext     — scale forward/backward in time from a hit
 *   unwindFromEvent      — chronological replay of how we got to an event
 *   getSessionTimeline   — full ordered dump of a session
 *
 * Usage:
 *   node dist/mcp-server/index.js
 */

import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { closePool } from '../timescale-client.js';
import { handleSearchMemory, SearchMemoryInput } from './tools/searchMemory.js';
import { handleGetMemoryContext, GetMemoryContextInput } from './tools/getMemoryContext.js';
import { handleUnwindFromEvent, UnwindFromEventInput } from './tools/unwindFromEvent.js';
import { handleGetSessionTimeline, GetSessionTimelineInput } from './tools/getSessionTimeline.js';
import { handleRateMemoryInjections, RateMemoryInjectionsInput } from './tools/rateMemoryInjections.js';

const TOOLS: Tool[] = [
  {
    name: 'searchMemory',
    description:
      'Fuzzy-search the long-term session memory for events matching a query. ' +
      'Uses trigram similarity (pg_trgm) against tool names, summaries, file paths, and user prompts. ' +
      'Returns ranked hits with event_id that you can pass to getMemoryContext or unwindFromEvent. ' +
      'Use when you need to recall past work — "where did we last edit X," "when did we change Y."',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Fuzzy search term. Can be a file name, tool, command, or concept.' },
        limit: { type: 'number', description: 'Max results. Default 20, max 100.' },
        sessionId: { type: 'string', description: 'Optional: restrict to a single session.' },
        eventType: { type: 'string', description: 'Optional: filter by event type (tool_call, user_prompt, session_start, stop).' },
        since: { type: 'string', description: 'Optional ISO timestamp. Only events at or after this time.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'getMemoryContext',
    description:
      'Given a memory event_id (from searchMemory), fetch events before and after it in the same session. ' +
      'Use to scale forward or backward in time around a hit to see what led up to and followed a specific moment.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the anchor event (from searchMemory).' },
        before: { type: 'number', description: 'Events to fetch before the anchor. Default 10, max 100.' },
        after: { type: 'number', description: 'Events to fetch after the anchor. Default 10, max 100.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'unwindFromEvent',
    description:
      'Given a memory event_id, return every event in that session from session start up to and including the anchor, in chronological order. ' +
      'Use to reconstruct the full path of how we got to a particular moment.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'UUID of the anchor event.' },
        limit: { type: 'number', description: 'Max events to return. Default 200, max 1000.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'getSessionTimeline',
    description:
      'Full chronological dump of a session. Optional event type filter. Use when you want the whole session arc, not a window.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to retrieve.' },
        eventType: { type: 'string', description: 'Optional: filter to one event type.' },
        limit: { type: 'number', description: 'Max events. Default 500, max 5000.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'rateMemoryInjections',
    description:
      'Rate the memories you were injected this turn so future recall improves. ' +
      'Call this when a Stop hook asks you to rate; pass the injection_id printed on the ' +
      '"injection: <id>" line inside the <memory-context> block, and a rating per event_id: ' +
      '+1 = used/helpful, 0 = saw it, neutral/unused, -1 = misleading or wrong. ' +
      'Be honest and discriminating — rating everything +1 teaches the system nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        injection_id: { type: 'string', description: 'The injection UUID from the "injection: <id>" line in the memory-context block.' },
        ratings: {
          type: 'array',
          description: 'One entry per injected memory you are rating.',
          items: {
            type: 'object',
            properties: {
              event_id: { type: 'string', description: 'The memory event_id being rated.' },
              rating: { type: 'number', description: '+1 used/helpful, 0 neutral/unused, -1 misleading/wrong.' },
            },
            required: ['event_id', 'rating'],
          },
        },
        session_id: { type: 'string', description: 'Optional: the current session id.' },
      },
      required: ['injection_id', 'ratings'],
    },
  },
];

const server = new Server(
  { name: 'memory-pkg', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'searchMemory':
        result = await handleSearchMemory(args as unknown as SearchMemoryInput);
        break;
      case 'getMemoryContext':
        result = await handleGetMemoryContext(args as unknown as GetMemoryContextInput);
        break;
      case 'unwindFromEvent':
        result = await handleUnwindFromEvent(args as unknown as UnwindFromEventInput);
        break;
      case 'getSessionTimeline':
        result = await handleGetSessionTimeline(args as unknown as GetSessionTimelineInput);
        break;
      case 'rateMemoryInjections':
        result = await handleRateMemoryInjections(args as unknown as RateMemoryInjectionsInput);
        break;
      default:
        result = `Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}`;
    }

    return { content: [{ type: 'text' as const, text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Error executing ${name}: ${message}\n\n` +
            `This may indicate the memory-pkg TimescaleDB is not running (default localhost:5432). ` +
            `Start it with \`docker compose -f docker-compose.memory-pkg.yml up -d\`, or check the .claude/memory/ buffer.`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Connect the stdio transport and run the server. Exported so the CLI can host
 * it under `memory-pkg mcp-server` (the `.mcp.json` stanza invokes the
 * memory-pkg bin with that subcommand). The process stays alive on the stdio
 * transport's open handles; signal handlers below own teardown.
 */
export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[memory-pkg] MCP server running on stdio\n');
}

async function shutdown(): Promise<void> {
  process.stderr.write('[memory-pkg] Shutting down...\n');
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('disconnect', () => { void shutdown(); });

// Auto-start only when executed directly (the memory-pkg-mcp bin), not when
// imported by the CLI's `mcp-server` command.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  startMcpServer().catch((err: unknown) => {
    process.stderr.write(`[memory-pkg] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
