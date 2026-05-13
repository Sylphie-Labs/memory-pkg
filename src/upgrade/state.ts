/**
 * state.ts -- Read/write the per-repo install state file at
 * `.memory-pkg/state.json`.
 *
 * The state file is the source of truth for which files this package owns
 * in the consumer's repo, which version installed them, and what their
 * SHA-256 hashes were at install time. `upgrade`, `status`, and `uninstall`
 * all read from it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const STATE_DIR = '.memory-pkg';
export const STATE_FILE = 'state.json';

export type InstallMode = 'global' | 'local';

export interface ManagedFile {
  path: string;
  installedHash: string;
}

export interface InstallState {
  version: string;
  installedAt: string;
  lastUpgradedAt: string;
  installMode: InstallMode;
  /** Absolute path to dist/cli/memory-pkg.js the init was run from. */
  cliPathAtInstall: string;
  managedFiles: ManagedFile[];
}

export function statePath(cwd: string): string {
  return path.join(cwd, STATE_DIR, STATE_FILE);
}

export function readState(cwd: string): InstallState | null {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as InstallState;
  } catch {
    return null;
  }
}

export function writeState(cwd: string, state: InstallState): void {
  const p = statePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function removeState(cwd: string): void {
  const p = statePath(cwd);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const dir = path.dirname(p);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore
  }
}

export function hashFile(absPath: string): string {
  if (!fs.existsSync(absPath)) return '';
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export type DriftStatus = 'unchanged' | 'modified' | 'missing' | 'unknown';

export function detectDrift(cwd: string, file: ManagedFile): DriftStatus {
  const abs = path.join(cwd, file.path);
  if (!fs.existsSync(abs)) return file.installedHash ? 'missing' : 'unknown';
  const current = hashFile(abs);
  if (current === file.installedHash) return 'unchanged';
  return 'modified';
}
