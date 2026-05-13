#!/usr/bin/env node
/**
 * memory-pkg.ts -- CLI dispatcher for memory-pkg.
 *
 * Commands:
 *   search <query> [--limit N] [--session ID] [--type TYPE] [--since ISO]
 *   context <eventId> [--before N] [--after N]
 *   unwind <eventId> [--limit N]
 *   timeline <sessionId> [--type TYPE] [--limit N]
 *   ingest
 *   schema
 */

import { handleSearchMemory } from '../mcp-server/tools/searchMemory.js';
import { handleGetMemoryContext } from '../mcp-server/tools/getMemoryContext.js';
import { handleUnwindFromEvent } from '../mcp-server/tools/unwindFromEvent.js';
import { handleGetSessionTimeline } from '../mcp-server/tools/getSessionTimeline.js';
import { closePool } from '../timescale-client.js';

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      'Usage:\n' +
      '\n' +
      'Setup & lifecycle:\n' +
      '  memory-pkg init [--local] [--docker] [--classifier-context]\n' +
      '  memory-pkg upgrade [--plan] [--confirm] [--force]   Bring repo to current version\n' +
      '  memory-pkg status                          Show install state and drift\n' +
      '  memory-pkg doctor [--no-network]           Run structural checks\n' +
      '  memory-pkg uninstall --confirm             Remove managed files and state\n' +
      '\n' +
      'Memory operations:\n' +
      '  memory-pkg schema                              (init/migrate the hypertable + indexes)\n' +
      '  memory-pkg ingest                              (flush buffer.jsonl to TimescaleDB)\n' +
      '  memory-pkg search <query> [--limit N] [--session ID] [--type TYPE] [--since ISO]\n' +
      '  memory-pkg context <eventId> [--before N] [--after N]\n' +
      '  memory-pkg unwind <eventId> [--limit N]\n' +
      '  memory-pkg timeline <sessionId> [--type TYPE] [--limit N]\n' +
      '  memory-pkg backfill-subsystems\n' +
      '  memory-pkg backfill-embeddings [--batch N]\n' +
      '  memory-pkg rationale [--session ID] [--limit N]   (uses local `claude` CLI)\n' +
      '  memory-pkg inject <prompt-text> [--session ID] [--limit N] [--transcript PATH]\n' +
      '  memory-pkg tune [--log PATH]                      (summarize rationale log)\n' +
      '\n' +
      '  memory-pkg --version                              Print package version\n' +
      '  memory-pkg --help                                 This message\n'
    );
    return;
  }

  if (cmd === '--version' || cmd === '-v') {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  try {
    switch (cmd) {
      case 'init': {
        const { runInit } = await import('./init.js');
        await runInit([arg, ...rest].filter(Boolean));
        break;
      }

      case 'setup': {
        // Deprecated alias for init. Kept for back-compat through the 0.x cycle.
        process.stderr.write(
          `[memory-pkg] 'setup' is a deprecated alias; use 'init' instead.\n`,
        );
        const { runInit } = await import('./init.js');
        await runInit([arg, ...rest].filter(Boolean));
        break;
      }

      case 'status': {
        const { runStatus } = await import('./status.js');
        await runStatus([arg, ...rest].filter(Boolean));
        break;
      }

      case 'uninstall': {
        const { runUninstall } = await import('./uninstall.js');
        await runUninstall([arg, ...rest].filter(Boolean));
        break;
      }

      case 'upgrade': {
        const { runUpgrade } = await import('./upgrade.js');
        await runUpgrade([arg, ...rest].filter(Boolean));
        break;
      }

      case 'doctor': {
        const { runDoctor } = await import('./doctor.js');
        const code = await runDoctor([arg, ...rest].filter(Boolean));
        if (code !== 0) process.exit(code);
        break;
      }
      case 'search':
        if (!arg) throw new Error('query required');
        process.stdout.write(
          (await handleSearchMemory({
            query: arg,
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
            sessionId: flags.session,
            eventType: flags.type,
            since: flags.since,
          })) + '\n'
        );
        break;

      case 'context':
        if (!arg) throw new Error('eventId required');
        process.stdout.write(
          (await handleGetMemoryContext({
            eventId: arg,
            before: flags.before ? parseInt(flags.before, 10) : undefined,
            after: flags.after ? parseInt(flags.after, 10) : undefined,
          })) + '\n'
        );
        break;

      case 'unwind':
        if (!arg) throw new Error('eventId required');
        process.stdout.write(
          (await handleUnwindFromEvent({
            eventId: arg,
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
          })) + '\n'
        );
        break;

      case 'timeline':
        if (!arg) throw new Error('sessionId required');
        process.stdout.write(
          (await handleGetSessionTimeline({
            sessionId: arg,
            eventType: flags.type,
            limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
          })) + '\n'
        );
        break;

      case 'ingest': {
        const { ingest } = await import('../ingest/ingester.js');
        const r = await ingest();
        process.stdout.write(`ingested ${r.inserted} event(s)\n`);
        break;
      }

      case 'schema': {
        const { initSchema } = await import('../schema.js');
        await initSchema();
        break;
      }

      case 'backfill-subsystems': {
        const { backfillSubsystems } = await import('../subsystem.js');
        const r = await backfillSubsystems();
        process.stdout.write(`scanned ${r.scanned}, updated ${r.updated}\n`);
        break;
      }

      case 'backfill-embeddings': {
        const { backfillEmbeddings } = await import('../embed.js');
        const batch = flags.batch ? parseInt(flags.batch, 10) : 32;
        const r = await backfillEmbeddings(batch);
        process.stdout.write(`updated ${r.updated}\n`);
        break;
      }

      case 'rationale': {
        const { synthesizeRationales } = await import('../rationale/synthesize.js');
        const r = await synthesizeRationales({
          sessionId: flags.session,
          limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
        });
        process.stdout.write(`synthesized ${r.synthesized}, skipped ${r.skipped}\n`);
        break;
      }

      case 'tune': {
        const { loadTraces, analyzeTraces, formatReport } = await import('../inject/rationale-log.js');
        const logPath = flags.log || process.env.DRIFT_MEMORY_LOG_PATH;
        if (!logPath) throw new Error('set DRIFT_MEMORY_LOG_PATH or pass --log PATH');
        const traces = loadTraces(logPath);
        process.stdout.write(formatReport(analyzeTraces(traces)) + '\n');
        break;
      }

      case 'inject': {
        // Prompt text may span multiple words; re-assemble from positional arg + stdin fallback.
        let prompt = arg ?? '';
        if (!prompt && !process.stdin.isTTY) {
          prompt = await new Promise<string>((resolve) => {
            let buf = '';
            process.stdin.on('data', (c) => (buf += c.toString('utf8')));
            process.stdin.on('end', () => resolve(buf.trim()));
          });
        }
        const { generateInjection } = await import('../inject/generate.js');
        const block = await generateInjection({
          query: prompt,
          currentSessionId: flags.session,
          limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
          transcriptPath: flags.transcript,
        });
        if (block) process.stdout.write(block + '\n');
        break;
      }

      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } finally {
    await closePool();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[memory] error: ${err instanceof Error ? err.message : String(err)}\n`);
  closePool().finally(() => process.exit(1));
});
