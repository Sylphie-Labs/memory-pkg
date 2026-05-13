/**
 * status.ts -- `memory-pkg status` command.
 *
 * Reads `.memory-pkg/state.json`, hashes each managed file currently on
 * disk, reports drift. Exits 0 regardless of drift (informational only).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectDrift, readState, type DriftStatus } from '../upgrade/state.js';

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function formatDuration(fromIso: string): string {
  const ms = Date.now() - new Date(fromIso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function statusGlyph(d: DriftStatus): string {
  return d === 'unchanged' ? '✓' : d === 'modified' ? '⚠' : d === 'missing' ? '✗' : '?';
}

function statusLabel(d: DriftStatus): string {
  switch (d) {
    case 'unchanged': return 'unchanged';
    case 'modified':  return 'modified since install';
    case 'missing':   return 'missing on disk';
    case 'unknown':   return 'unknown';
  }
}

export async function runStatus(_args: string[]): Promise<number> {
  const cwd = process.cwd();
  const state = readState(cwd);

  if (!state) {
    process.stdout.write(`memory-pkg: not initialized in this repo.\n`);
    process.stdout.write(`Run 'memory-pkg init' to set up.\n`);
    return 0;
  }

  const currentVersion = readPackageVersion();
  const versionMatch = state.version === currentVersion;

  process.stdout.write(
    `memory-pkg ${state.version} (${state.installMode}${versionMatch ? '' : `, CLI is ${currentVersion}`})\n`,
  );
  process.stdout.write(`Installed:    ${state.installedAt}  (${formatDuration(state.installedAt)})\n`);
  process.stdout.write(`Last upgrade: ${state.lastUpgradedAt}  (${formatDuration(state.lastUpgradedAt)})\n`);

  if (!versionMatch) {
    process.stdout.write(
      `\nVersion mismatch: ${state.version} installed -> ${currentVersion} available.\n` +
        `Run 'memory-pkg upgrade --plan' to see what would change.\n`,
    );
  }

  process.stdout.write(`\nManaged files (${state.managedFiles.length}):\n`);
  const counts: Record<DriftStatus, number> = { unchanged: 0, modified: 0, missing: 0, unknown: 0 };
  for (const f of state.managedFiles) {
    const d = detectDrift(cwd, f);
    counts[d]++;
    process.stdout.write(`  ${statusGlyph(d)} ${f.path.padEnd(60)} ${statusLabel(d)}\n`);
  }

  if (counts.modified > 0 || counts.missing > 0) {
    process.stdout.write(
      `\nDrift summary: ${counts.modified} modified, ${counts.missing} missing, ${counts.unchanged} unchanged.\n` +
        `'upgrade' skips drifted files by default; pass --force to overwrite (creates .bak).\n`,
    );
  }

  return 0;
}
