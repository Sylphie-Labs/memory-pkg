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
      '  memory-pkg init [--local] [--docker]\n' +
      '  memory-pkg upgrade [--plan] [--confirm] [--force]   Bring repo to current version\n' +
      '  memory-pkg status                          Show install state and drift\n' +
      '  memory-pkg doctor [--no-network]           Run structural checks\n' +
      '  memory-pkg uninstall --confirm             Remove managed files and state\n' +
      '\n' +
      'Memory operations:\n' +
      '  memory-pkg schema                              (init/migrate the hypertable + indexes)\n' +
      '  memory-pkg ingest [--retry-failed]             (flush buffer.jsonl to TimescaleDB; --retry-failed re-queues the dead-letter file)\n' +
      '  memory-pkg search <query> [--limit N] [--session ID] [--type TYPE] [--since ISO]\n' +
      '  memory-pkg context <eventId> [--before N] [--after N]\n' +
      '  memory-pkg unwind <eventId> [--limit N]\n' +
      '  memory-pkg timeline <sessionId> [--type TYPE] [--limit N]\n' +
      '  memory-pkg backfill-subsystems\n' +
      '  memory-pkg backfill-embeddings [--batch N]\n' +
      '  memory-pkg rationale [--session ID] [--limit N]   (uses local `claude` CLI)\n' +
      '  memory-pkg consolidate [--deep] [--if-stale H] [--budget-ms N] [--session ID]\n' +
      '                                                   (run derived-write processors: ingest, rationale, …)\n' +
      '  memory-pkg entity <name>                         (resolve an entity; list its linked events + rationales)\n' +
      '  memory-pkg inject <prompt-text> [--session ID] [--limit N] [--transcript PATH]\n' +
      '  memory-pkg tune [--log PATH]                      (summarize rationale log)\n' +
      '  memory-pkg feedback                               (rating distribution + usefulness gate report)\n' +
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
        const ingestArgs = [arg, ...rest].filter((x): x is string => Boolean(x));
        const r = await ingest({ retryFailed: ingestArgs.includes('--retry-failed') });
        process.stdout.write(
          r.skipped === 'locked'
            ? `ingest skipped: another ingest is running\n`
            : `ingested ${r.inserted} event(s)\n`,
        );
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

      case 'consolidate': {
        // No positional arg; flags may include the first token (arg), so
        // re-parse the full tail like `inject` does.
        const cflags = parseFlags([arg, ...rest].filter((x): x is string => Boolean(x)));
        const { runConsolidation } = await import('../consolidate/runner.js');
        const r = await runConsolidation({
          deep: cflags.deep === 'true',
          sessionId: cflags.session,
          budgetMs: cflags['budget-ms'] ? parseInt(cflags['budget-ms'], 10) : undefined,
          ifStaleHours: cflags['if-stale'] ? parseInt(cflags['if-stale'], 10) : undefined,
        });
        if (!r.ran) {
          process.stdout.write(`consolidate skipped: ${r.skipped}\n`);
        } else {
          const summary = r.processors
            .map((p) => `${p.name}(processed=${p.processed},skipped=${p.skipped})`)
            .join(' ');
          process.stdout.write(
            `consolidate ${r.deep ? 'deep' : 'tick'} done: ${summary || '(no processors ran)'}\n`,
          );
        }
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

      case 'feedback': {
        const { runFeedback } = await import('./feedback.js');
        await runFeedback();
        break;
      }

      case 'ambient': {
        // Mid-turn ambient recall for the PostToolUse hook. Reads
        // {session_id, entities[]} from stdin; prints JSON {text, injected}.
        const { runAmbient } = await import('./ambient.js');
        await runAmbient();
        break;
      }

      case 'entity': {
        if (!arg) throw new Error('entity name required');
        const { runQuery } = await import('../timescale-client.js');
        const { normalizeEntity } = await import('../entities/extract.js');
        const norm = normalizeEntity(arg);
        const ents = await runQuery<{
          entity_id: string;
          name_norm: string;
          display_name: string;
          event_count: number;
        }>(
          `SELECT entity_id, name_norm, display_name, event_count
           FROM memory_entities
           WHERE name_norm = $1 OR ($1 <% name_norm AND word_similarity($1, name_norm) >= 0.4)
           ORDER BY (name_norm = $1) DESC, word_similarity($1, name_norm) DESC
           LIMIT 5`,
          [norm],
        );
        if (ents.length === 0) {
          process.stdout.write(`no entity matching "${arg}"\n`);
          break;
        }
        for (const e of ents) {
          process.stdout.write(`entity ${e.display_name} (${e.name_norm}) — ${e.event_count} event(s)\n`);
          const links = await runQuery<{
            event_id: string;
            event_type: string;
            summary: string | null;
          }>(
            `SELECT l.event_id, l.event_type, ev.summary
             FROM memory_entity_events l
             JOIN memory_events ev ON ev.event_id = l.event_id AND ev.ts = l.event_ts
             WHERE l.entity_id = $1 AND l.event_type <> 'tool_result'
             ORDER BY (l.event_type = 'turn_rationale') DESC, l.event_ts DESC
             LIMIT 10`,
            [e.entity_id],
          );
          for (const ln of links) {
            process.stdout.write(
              `  [${ln.event_type}] ${ln.event_id.slice(0, 8)} ${(ln.summary ?? '').slice(0, 80)}\n`,
            );
          }
        }
        break;
      }

      case 'inject': {
        // Prompt is the positional arg, or read from stdin when the
        // positional is '-' (or absent and stdin is piped). The '-' sentinel
        // is what the memory-inject.cjs hook uses to avoid Windows argv limits.
        const injectArgs = [arg, ...rest].filter((x): x is string => Boolean(x));
        const injectFlags = parseFlags(injectArgs);
        const positional = arg && arg !== '-' && !arg.startsWith('--') ? arg : '';
        let prompt = positional;
        if (!prompt && (arg === '-' || !process.stdin.isTTY)) {
          prompt = await new Promise<string>((resolve) => {
            let buf = '';
            process.stdin.on('data', (c) => (buf += c.toString('utf8')));
            process.stdin.on('end', () => resolve(buf.trim()));
          });
        }
        const { generateInjection } = await import('../inject/generate.js');
        const block = await generateInjection({
          query: prompt,
          currentSessionId: injectFlags.session,
          limit: injectFlags.limit ? parseInt(injectFlags.limit, 10) : undefined,
          transcriptPath: injectFlags.transcript,
          // The CLI inject command IS the hook path — persist the injection so
          // it can be rated at Stop. (--no-persist opts out for manual testing.)
          persistInjection: injectFlags['no-persist'] !== 'true',
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
