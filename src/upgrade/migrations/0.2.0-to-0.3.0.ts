/**
 * 0.2.0 → 0.3.0 -- Refresh the capture hook; flag the new auto-rationale wiring.
 *
 * 0.3.0 fixes silent event loss in the capture hook: events parsed from a
 * single transcript line (parallel tool calls, mixed text+tool messages,
 * multiple tool_results) shared one transcript_uuid/ts and collided on the
 * (session_id, transcript_uuid, ts) unique index — all but one were dropped by
 * ON CONFLICT DO NOTHING. This migration re-installs the fixed
 * `.claude/hooks/memory-capture.cjs` from the bundled template.
 *
 * It also surfaces a warning: automatic rationale synthesis now lives in the
 * settings.json Stop hook (chained after ingest), but settings.json is
 * hand-merged so we cannot edit it here. The user must re-merge the snippet
 * that `memory-pkg init` prints (or `memory-pkg doctor` will flag it).
 *
 * Drift-safe: an unchanged hook is overwritten and re-hashed; a hook the user
 * modified is left alone (warning) unless `--force`, in which case a
 * `.bak.<timestamp>` copy is kept before overwriting.
 */

import * as fs from 'fs';
import * as path from 'path';

import { detectDrift, hashFile, normalizePath, type ManagedFile } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const CAPTURE_REL = normalizePath('.claude/hooks/memory-capture.cjs');

const migration_0_2_0_to_0_3_0: Migration = {
  from: '0.2.0',
  to: '0.3.0',
  severity: 'minor',
  description: 'Refresh memory-capture.cjs (multi-event transcript fix); flag auto-rationale Stop hook',
  notes:
    'Re-installs the capture hook with the fix for silent event loss on ' +
    'multi-event transcript lines (parallel tool calls were being dropped). ' +
    'Also: automatic rationale synthesis now runs from the settings.json Stop ' +
    'hook — re-merge the snippet from `memory-pkg init` (settings.json is ' +
    'hand-merged, so this migration cannot edit it for you). ' +
    'A modified hook is left untouched unless you pass --force.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];
    const changedFiles: string[] = [];
    const managedFiles: ManagedFile[] = ctx.state.managedFiles.map((f) => ({ ...f }));

    const srcAbs = path.join(ctx.packageRoot, 'template', '.claude', 'hooks', 'memory-capture.cjs');
    const destAbs = path.join(ctx.cwd, CAPTURE_REL);
    const tracked = managedFiles.find((f) => f.path === CAPTURE_REL);

    const rehash = (): void => {
      const hash = ctx.dryRun ? '' : hashFile(destAbs);
      if (tracked) tracked.installedHash = hash;
      else managedFiles.push({ path: CAPTURE_REL, installedHash: hash });
    };

    if (!fs.existsSync(srcAbs)) {
      warnings.push(`bundled capture-hook template missing at ${srcAbs}; skipped refresh`);
    } else if (!fs.existsSync(destAbs)) {
      // Not present in the consumer repo — install it fresh.
      if (!ctx.dryRun) {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(srcAbs, destAbs);
      }
      changedFiles.push(CAPTURE_REL);
      rehash();
    } else {
      const drift = tracked ? detectDrift(ctx.cwd, tracked) : 'unknown';
      const isModified = drift === 'modified';
      if (isModified && !ctx.force) {
        warnings.push(
          `${CAPTURE_REL} was modified since install; left as-is. Re-run with --force to ` +
            `overwrite (a .bak copy is kept), or merge the multi-event fix by hand.`,
        );
      } else {
        if (!ctx.dryRun) {
          if (isModified && ctx.force) {
            fs.copyFileSync(destAbs, `${destAbs}.bak.${Date.now()}`);
          }
          fs.copyFileSync(srcAbs, destAbs);
        }
        changedFiles.push(CAPTURE_REL);
        rehash();
      }
    }

    warnings.push(
      'Automatic rationale synthesis needs a settings.json change: your Stop hook should ' +
        'chain `npx -y @sylphie-labs/memory-pkg rationale` after `ingest`. Run `memory-pkg init` ' +
        'to reprint the current snippet, then merge it into .claude/settings.json. ' +
        '`memory-pkg doctor` reports whether it is wired.',
    );

    return { managedFiles, changedFiles, warnings };
  },
};

export default migration_0_2_0_to_0_3_0;
