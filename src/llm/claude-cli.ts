/**
 * llm/claude-cli.ts -- Shared helper to shell out to the local `claude` CLI in
 * print mode (one-shot, non-interactive). Uses the user's authenticated
 * account via the terminal — no API key. Extracted from rationale/synthesize.ts
 * so both rationale synthesis and fact promotion use one implementation.
 *
 * The model is chosen by getModelFor(kind); the prompt goes via stdin to avoid
 * shell-quoting issues with multi-line content.
 */

import { spawn } from 'child_process';
import { getModelFor, type SpawnKind } from '../config.js';

const CLAUDE_BIN = process.env.MEMORY_PKG_CLAUDE_BIN ?? 'claude';

export function callClaudeCli(prompt: string, kind: SpawnKind = 'rationale', timeoutMs = 60_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, ['-p', '--model', getModelFor(kind)], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`failed to spawn ${CLAUDE_BIN}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}. stderr: ${stderr.slice(0, 500)}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error('claude CLI returned empty output'));
        return;
      }
      resolve(text);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
