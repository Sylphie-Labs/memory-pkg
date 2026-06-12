/**
 * mcpServerCommand.test.ts -- Regression guard for the `.mcp.json` invocation.
 *
 * The MCP stanza runs `memory-pkg mcp-server`. That subcommand must exist and
 * boot the stdio server (it once didn't — the CLI replied "unknown command:
 * mcp-server" and Claude Code reported -32000). This spawns the built CLI with
 * that subcommand and asserts the server announces readiness rather than
 * erroring. Skips if dist isn't built (the suite runs against src).
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const CLI = path.resolve('dist/cli/memory-pkg.js');

function bootMcp(): Promise<{ stderr: string; ok: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [CLI, 'mcp-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ stderr, ok });
    };
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.includes('MCP server running on stdio')) done(true);
      if (/unknown command/i.test(stderr)) done(false);
    });
    proc.on('exit', () => done(false));
    setTimeout(() => done(false), 8000);
  });
}

describe('memory-pkg mcp-server (the .mcp.json invocation)', () => {
  it('boots the stdio server and does not error with "unknown command"', async (ctx) => {
    if (!existsSync(CLI)) return ctx.skip(); // dist not built
    const { stderr, ok } = await bootMcp();
    expect(stderr).not.toMatch(/unknown command/i);
    expect(stderr).toContain('MCP server running on stdio');
    expect(ok).toBe(true);
  }, 12000);
});
