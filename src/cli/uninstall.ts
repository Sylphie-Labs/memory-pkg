/**
 * uninstall.ts -- `memory-pkg uninstall` command.
 *
 * Removes every file recorded in `.memory-pkg/state.json`, then the state
 * file itself. Modified files (drift detected) are renamed to
 * `<path>.bak.<timestamp>` rather than deleted.
 *
 * Requires `--confirm` (per the project's rule that any state change is
 * opt-in).
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectDrift, readState, removeState } from '../upgrade/state.js';

type Flags = {
  dryRun: boolean;
  confirm: boolean;
  force: boolean;
};

function parseFlags(args: string[]): Flags {
  return {
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm') || args.includes('--yes'),
    force: args.includes('--force'),
  };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export async function runUninstall(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const state = readState(cwd);

  if (!state) {
    process.stdout.write(`memory-pkg: not initialized in this repo. Nothing to uninstall.\n`);
    return 0;
  }

  process.stdout.write(`memory-pkg uninstall — plan:\n\n`);
  const ts = timestamp();
  const plan: Array<{ rel: string; action: 'delete' | 'backup-and-delete' | 'skip-missing' }> = [];

  for (const f of state.managedFiles) {
    const drift = detectDrift(cwd, f);
    if (drift === 'missing' || drift === 'unknown') {
      plan.push({ rel: f.path, action: 'skip-missing' });
    } else if (drift === 'modified' && !flags.force) {
      plan.push({ rel: f.path, action: 'backup-and-delete' });
    } else {
      plan.push({ rel: f.path, action: 'delete' });
    }
  }

  for (const step of plan) {
    const label =
      step.action === 'delete'
        ? 'delete'
        : step.action === 'backup-and-delete'
          ? `back up to ${step.rel}.bak.${ts}, then delete`
          : 'skip (missing)';
    process.stdout.write(`  - ${step.rel.padEnd(60)} ${label}\n`);
  }
  process.stdout.write(`  - .memory-pkg/state.json                                         delete\n`);

  if (flags.dryRun) {
    process.stdout.write(`\n[uninstall] dry-run — no changes made.\n`);
    return 0;
  }

  if (!flags.confirm) {
    process.stdout.write(
      `\nUninstall will remove the files above. Re-run with --confirm to proceed.\n` +
        `(Modified files are backed up to .bak.<timestamp> first unless --force is also passed.)\n`,
    );
    return 0;
  }

  let deleted = 0, backedUp = 0, skipped = 0;
  for (const step of plan) {
    const abs = path.join(cwd, step.rel);
    if (step.action === 'skip-missing') { skipped++; continue; }
    try {
      if (step.action === 'backup-and-delete') {
        fs.renameSync(abs, `${abs}.bak.${ts}`);
        backedUp++;
        continue;
      }
      fs.unlinkSync(abs);
      deleted++;
    } catch (err) {
      process.stderr.write(
        `[uninstall] failed to remove ${step.rel}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  removeState(cwd);

  process.stdout.write(
    `\n[uninstall] Done. ${deleted} deleted, ${backedUp} backed up, ${skipped} skipped.\n` +
      `State file removed.\n`,
  );

  return 0;
}
