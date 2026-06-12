/**
 * installSettings.test.ts -- Settings-merge behavior for the consolidate
 * entrypoint (Phase 1).
 *
 * installSettings() JSON-merges our hook entries into .claude/settings.json.
 * Phase 1 changed it to (a) emit the `consolidate` Stop entry, (b) strip the
 * superseded `memory-pkg ingest` entry via the `replaces` rule even without
 * --force, and (c) honor a per-entry `matcher`. These tests pin that contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { installSettings } from '../src/cli/init.js';

let cwd: string;

function settingsPath(): string {
  return path.join(cwd, '.claude', 'settings.json');
}
function readSettings(): any {
  return JSON.parse(readFileSync(settingsPath(), 'utf8'));
}
function writeSettings(obj: unknown): void {
  const p = settingsPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}
/** Every hook command string across all events/groups. */
function allCommands(s: any): string[] {
  const out: string[] = [];
  for (const groups of Object.values(s.hooks ?? {})) {
    for (const g of groups as any[]) {
      for (const h of g.hooks ?? []) out.push(h.command);
    }
  }
  return out;
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'mpkg-settings-'));
  // installSettings writes under cwd/.claude — ensure the dir tree is creatable.
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('installSettings consolidate wiring', () => {
  it('writes the consolidate Stop entry on a fresh repo', () => {
    installSettings(cwd, { force: false, dryRun: false });
    const cmds = allCommands(readSettings());
    expect(cmds.some((c) => c.includes('memory-pkg consolidate'))).toBe(true);
    expect(cmds.some((c) => c.includes('memory-inject.cjs'))).toBe(true);
    expect(cmds.some((c) => c.includes('memory-capture.cjs'))).toBe(true);
    // No legacy ingest chain.
    expect(cmds.some((c) => c.includes('memory-pkg ingest'))).toBe(false);
  });

  it('is idempotent: a second run makes no changes', () => {
    installSettings(cwd, { force: false, dryRun: false });
    const first = readFileSync(settingsPath(), 'utf8');
    installSettings(cwd, { force: false, dryRun: false });
    const second = readFileSync(settingsPath(), 'utf8');
    expect(second).toBe(first);
  });

  it('strips the legacy `ingest && rationale` Stop entry even without --force', () => {
    // Simulate a pre-0.5.0 repo wired with the old chain.
    writeSettings({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'node .claude/hooks/memory-capture.cjs', timeout: 10 },
              {
                type: 'command',
                command:
                  'npx -y @sylphie-labs/memory-pkg ingest && npx -y @sylphie-labs/memory-pkg rationale --limit 20',
                timeout: 120,
                async: true,
              },
            ],
          },
        ],
      },
    });

    installSettings(cwd, { force: false, dryRun: false });
    const cmds = allCommands(readSettings());

    expect(cmds.some((c) => c.includes('memory-pkg ingest'))).toBe(false);
    expect(cmds.some((c) => c.includes('rationale --limit 20'))).toBe(false);
    expect(cmds.some((c) => c.includes('memory-pkg consolidate'))).toBe(true);
    // The capture hook in the same group is preserved.
    expect(cmds.some((c) => c.includes('memory-capture.cjs'))).toBe(true);
  });

  it('does not duplicate consolidate when both legacy ingest and consolidate already exist', () => {
    writeSettings({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'npx -y @sylphie-labs/memory-pkg ingest', timeout: 120, async: true },
              { type: 'command', command: 'npx -y @sylphie-labs/memory-pkg consolidate', timeout: 120, async: true },
            ],
          },
        ],
      },
    });

    installSettings(cwd, { force: false, dryRun: false });
    const cmds = allCommands(readSettings());

    expect(cmds.filter((c) => c.includes('memory-pkg consolidate')).length).toBe(1);
    expect(cmds.some((c) => c.includes('memory-pkg ingest'))).toBe(false);
  });

  it('leaves an unparseable settings.json untouched', () => {
    const p = settingsPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{ not json');
    installSettings(cwd, { force: false, dryRun: false });
    expect(readFileSync(p, 'utf8')).toBe('{ not json');
  });

  it('dry-run does not write the file', () => {
    installSettings(cwd, { force: false, dryRun: true });
    expect(existsSync(settingsPath())).toBe(false);
  });
});
