/**
 * 0.7.0 → 0.8.0 -- Mid-turn ambient injection (F1) + implicit cross-check (F4).
 *
 * What 0.8.0 adds in a consumer repo:
 *   1. `.claude/hooks/memory-ambient.cjs` — new PostToolUse hook (matcher
 *      Grep|Glob|Read|Task) that injects ambient recall mid-turn.
 *   2. `.claude/hooks/memory-inject.cjs` — re-rendered: it now writes a turn
 *      boundary marker to the ambient ledger (for the per-turn injection cap).
 *   3. `.claude/settings.json` — the PostToolUse hook entry (with its matcher).
 *
 * No database schema change (the referenced-check processor reuses the v3
 * tables). Hooks/settings only; a modified hook is left as-is without --force.
 */

import * as fs from 'fs';
import * as path from 'path';

import { installSettings, renderInjectHook } from '../../cli/init.js';
import { detectDrift, hashFile, normalizePath, type ManagedFile } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const AMBIENT_REL = normalizePath('.claude/hooks/memory-ambient.cjs');
const INJECT_REL = normalizePath('.claude/hooks/memory-inject.cjs');

const migration_0_7_0_to_0_8_0: Migration = {
  from: '0.7.0',
  to: '0.8.0',
  severity: 'minor',
  description:
    'Add the mid-turn ambient PostToolUse hook + refresh the inject hook (turn ' +
    'boundary marker); implicit referenced-check processor',
  notes:
    'Installs memory-ambient.cjs (PostToolUse, matcher Grep|Glob|Read|Task), ' +
    're-renders memory-inject.cjs so it marks turn boundaries for the ambient ' +
    'per-turn cap, and merges the PostToolUse settings entry. No schema change. ' +
    'A modified hook is left as-is without --force (a .bak copy is kept on --force).',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];
    const changedFiles: string[] = [];
    const managedFiles: ManagedFile[] = ctx.state.managedFiles.map((f) => ({ ...f }));

    const refreshHook = (rel: string, content: string | Buffer | null): void => {
      if (content === null) {
        warnings.push(`bundled template for ${rel} missing; skipped refresh`);
        return;
      }
      const destAbs = path.join(ctx.cwd, rel);
      const tracked = managedFiles.find((f) => f.path === rel);
      const exists = fs.existsSync(destAbs);
      const drift = exists && tracked ? detectDrift(ctx.cwd, tracked) : exists ? 'unknown' : 'absent';
      if (exists && drift === 'modified' && !ctx.force) {
        warnings.push(`${rel} was modified since install; left as-is. Re-run with --force to overwrite.`);
        return;
      }
      if (!ctx.dryRun) {
        if (exists && drift === 'modified' && ctx.force) {
          fs.copyFileSync(destAbs, `${destAbs}.bak.${Date.now()}`);
        }
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.writeFileSync(destAbs, content);
      }
      changedFiles.push(rel);
      const hash = ctx.dryRun ? '' : hashFile(destAbs);
      if (tracked) tracked.installedHash = hash;
      else managedFiles.push({ path: rel, installedHash: hash });
    };

    // 1. New ambient hook (straight copy from template).
    const ambientSrc = path.join(ctx.packageRoot, 'template', '.claude', 'hooks', 'memory-ambient.cjs');
    refreshHook(AMBIENT_REL, fs.existsSync(ambientSrc) ? fs.readFileSync(ambientSrc) : null);

    // 2. Re-render the inject hook (now writes the turn-boundary marker).
    const injectTemplate = path.join(ctx.packageRoot, 'template', '.claude', 'hooks', 'memory-inject.cjs');
    let injectContent: string | null = null;
    if (fs.existsSync(injectTemplate)) {
      injectContent = renderInjectHook(path.join(ctx.packageRoot, 'dist', 'cli', 'memory-pkg.js'));
    }
    refreshHook(INJECT_REL, injectContent);

    // 3. Merge the PostToolUse settings entry.
    try {
      installSettings(ctx.cwd, { force: ctx.force, dryRun: ctx.dryRun });
    } catch (err) {
      warnings.push(
        `could not merge the ambient PostToolUse hook into .claude/settings.json ` +
          `(${err instanceof Error ? err.message : String(err)}); run ` +
          `\`memory-pkg init --hooks-only --force\` or merge by hand.`,
      );
    }

    return { managedFiles, changedFiles, warnings };
  },
};

export default migration_0_7_0_to_0_8_0;
