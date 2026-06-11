/**
 * 0.3.0 → 0.4.0 -- Correctness hardening: refresh both hooks, auto-merge
 * settings.json, untrack .mcp.json, stamp the DB schema version.
 *
 * What 0.4.0 changes in a consumer repo:
 *
 *   1. `.claude/hooks/memory-capture.cjs` — tool_use payloads are now capped
 *      at 8,000 chars (mirroring the tool_result cap) and the dead
 *      `cursor.lastUuid` field is gone. Re-installed from the bundled
 *      template, drift-safe.
 *   2. `.claude/hooks/memory-inject.cjs` — the prompt is now passed to
 *      `inject` via stdin with the `-` sentinel instead of argv, avoiding the
 *      ~32KB Windows CreateProcess command-line cap that silently disabled
 *      injection for long pasted prompts. Re-rendered with the current
 *      install's CLI path baked in, drift-safe.
 *   3. `.claude/settings.json` — hook commands move to relative paths
 *      (`node .claude/hooks/...`) and the Stop-hook ingest command drops the
 *      POSIX-only redirection. 0.4.0's `installSettings` JSON-merges these
 *      idempotently (marker-substring detection); with `--force` our old
 *      marker-matching entries are replaced by the fresh ones.
 *   4. `.mcp.json` leaves `managedFiles` — it is a shared, user-merged file;
 *      hash-drift on it is meaningless and uninstall must never delete it.
 *      `doctor`'s checkMcpStanza validates the stanza instead.
 *   5. `memory_meta` table — DB schema versioning lands. We create the table
 *      and stamp `schema_version = 1` (the schema as of 0.3.0/0.4.0; no other
 *      DDL changed) if not already stamped. An unreachable database degrades
 *      to a warning and never aborts the file-level upgrade; `memory-pkg
 *      schema` stamps it later.
 *
 * Drift-safe: an unchanged hook is overwritten and re-hashed; a hook the user
 * modified is left alone (warning) unless `--force`, in which case a
 * `.bak.<timestamp>` copy is kept before overwriting.
 */

import * as fs from 'fs';
import * as path from 'path';

import { installSettings, renderInjectHook } from '../../cli/init.js';
import { detectDrift, hashFile, normalizePath, type ManagedFile } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const CAPTURE_REL = normalizePath('.claude/hooks/memory-capture.cjs');
const INJECT_REL = normalizePath('.claude/hooks/memory-inject.cjs');
const MCP_REL = '.mcp.json';

/**
 * Schema version this migration stamps. Frozen at the value current when
 * 0.4.0 shipped (see src/schema.ts SCHEMA_VERSION) — a migration is a
 * historical artifact and must not chase the live constant.
 */
const SCHEMA_VERSION_AT_0_4_0 = 1;

const migration_0_3_0_to_0_4_0: Migration = {
  from: '0.3.0',
  to: '0.4.0',
  severity: 'minor',
  description:
    'Refresh capture/inject hooks (tool_use cap, stdin prompt passing); ' +
    'auto-merge settings.json hooks; untrack .mcp.json; stamp DB schema_version',
  notes:
    'Re-installs both hooks from the bundled templates (a modified hook is ' +
    'left untouched unless you pass --force; a .bak copy is kept). Hook ' +
    'commands in .claude/settings.json are JSON-merged automatically now — ' +
    'with --force the old $CLAUDE_PROJECT_DIR-style entries are replaced by ' +
    'the cross-platform relative-path ones. .mcp.json is no longer ' +
    'hash-tracked (doctor validates the stanza). Finally, the memory_meta ' +
    'table is created and schema_version stamped; if the database is ' +
    'unreachable this degrades to a warning — run `memory-pkg schema` later.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];
    const changedFiles: string[] = [];
    const managedFiles: ManagedFile[] = ctx.state.managedFiles
      .filter((f) => f.path !== MCP_REL)
      .map((f) => ({ ...f }));

    if (ctx.state.managedFiles.some((f) => f.path === MCP_REL)) {
      warnings.push(
        `${MCP_REL} removed from managed-file tracking (shared file; ` +
          `'memory-pkg doctor' validates the server stanza instead). The file itself is untouched.`,
      );
    }

    // --- 1+2. Refresh the two hook files, drift-safe. -----------------------
    const refreshHook = (rel: string, content: string | Buffer | null): void => {
      const destAbs = path.join(ctx.cwd, rel);
      const tracked = managedFiles.find((f) => f.path === rel);

      const rehash = (): void => {
        const hash = ctx.dryRun ? '' : hashFile(destAbs);
        if (tracked) tracked.installedHash = hash;
        else managedFiles.push({ path: rel, installedHash: hash });
      };

      if (content === null) {
        warnings.push(`bundled template for ${rel} missing; skipped refresh`);
        return;
      }

      const write = (): void => {
        if (!ctx.dryRun) {
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.writeFileSync(destAbs, content);
        }
        changedFiles.push(rel);
        rehash();
      };

      if (!fs.existsSync(destAbs)) {
        write();
        return;
      }
      const drift = tracked ? detectDrift(ctx.cwd, tracked) : 'unknown';
      const isModified = drift === 'modified';
      if (isModified && !ctx.force) {
        warnings.push(
          `${rel} was modified since install; left as-is. Re-run with --force to ` +
            `overwrite (a .bak copy is kept), or merge the 0.4.0 changes by hand.`,
        );
        return;
      }
      if (isModified && ctx.force && !ctx.dryRun) {
        fs.copyFileSync(destAbs, `${destAbs}.bak.${Date.now()}`);
      }
      write();
    };

    const captureSrc = path.join(
      ctx.packageRoot, 'template', '.claude', 'hooks', 'memory-capture.cjs',
    );
    refreshHook(CAPTURE_REL, fs.existsSync(captureSrc) ? fs.readFileSync(captureSrc) : null);

    const injectTemplate = path.join(
      ctx.packageRoot, 'template', '.claude', 'hooks', 'memory-inject.cjs',
    );
    let injectContent: string | null = null;
    if (fs.existsSync(injectTemplate)) {
      const bakedCliPath = path.join(ctx.packageRoot, 'dist', 'cli', 'memory-pkg.js');
      injectContent = renderInjectHook(bakedCliPath);
    }
    refreshHook(INJECT_REL, injectContent);

    // --- 3. JSON-merge the hook entries into .claude/settings.json. ---------
    // installSettings is idempotent (marker-substring detection) and falls
    // back to printing the snippet when the file is unparseable JSON. With
    // --force, our old-style entries (absolute-path / $CLAUDE_PROJECT_DIR
    // commands) are replaced by the 0.4.0 relative-path ones.
    try {
      installSettings(ctx.cwd, { force: ctx.force, dryRun: ctx.dryRun });
      if (!ctx.force) {
        warnings.push(
          'settings.json: pre-0.4.0 hook entries (matched by marker) are kept as-is ' +
            'without --force. If your Stop/UserPromptSubmit commands still use ' +
            '"$CLAUDE_PROJECT_DIR" paths, re-run the upgrade with --force or run ' +
            '`memory-pkg init --hooks-only --force` to switch them to the ' +
            'cross-platform relative-path form.',
        );
      }
    } catch (err) {
      warnings.push(
        `could not merge hook entries into .claude/settings.json ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `run \`memory-pkg init --hooks-only --force\` or merge the snippet by hand.`,
      );
    }

    // --- 4. Stamp the DB schema version (files-first ordering: everything ---
    // above is already done, so a DB failure leaves a consistent, re-runnable
    // state).
    if (ctx.dryRun) {
      // No DB writes on dry runs.
    } else if (!ctx.runQuery) {
      warnings.push(
        'database not configured; schema_version not stamped. ' +
          'Run `memory-pkg schema` once the database is reachable.',
      );
    } else {
      try {
        await ctx.runQuery(`
          CREATE TABLE IF NOT EXISTS memory_meta (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        // DO NOTHING (not DO UPDATE): never regress a version stamped by a
        // newer `memory-pkg schema` run.
        await ctx.runQuery(
          `INSERT INTO memory_meta (key, value, updated_at)
           VALUES ('schema_version', $1, NOW())
           ON CONFLICT (key) DO NOTHING`,
          [String(SCHEMA_VERSION_AT_0_4_0)],
        );
      } catch (err) {
        warnings.push(
          `database unreachable; schema_version not stamped ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `Run \`memory-pkg schema\` once the database is reachable.`,
        );
      }
    }

    return { managedFiles, changedFiles, warnings };
  },
};

export default migration_0_3_0_to_0_4_0;
