/**
 * setup.ts -- `memory-pkg setup` command.
 *
 * Bootstraps a consumer's project to use memory-pkg. Runs from the consumer's
 * cwd (the repo root) and installs:
 *
 *   1. Hook scripts at <cwd>/.claude/hooks/
 *      - memory-capture.cjs   (Stop event, reads transcript -> buffer.jsonl)
 *      - memory-inject.cjs    (UserPromptSubmit, spawns CLI -> additionalContext)
 *   2. The memory-pkg MCP server stanza in <cwd>/.mcp.json
 *   3. A .claude/settings.json snippet (printed; not auto-merged because
 *      settings.json is usually hand-customized)
 *   4. temporal-recall skill at <cwd>/.claude/skills/temporal-recall/
 *   5. .memory-pkg/classifier-context.md stub (only if --classifier-context)
 *   6. docker-compose.memory-pkg.yml (only if --docker)
 *
 * Idempotent: skips existing files unless --force. With --dry-run, prints what
 * would happen without writing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

type Flags = {
  dryRun: boolean;
  force: boolean;
  docker: boolean;
  classifierContext: boolean;
  hooksOnly: boolean;
  mcpOnly: boolean;
  skillsOnly: boolean;
};

function parseFlags(args: string[]): Flags {
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    docker: args.includes('--docker'),
    classifierContext: args.includes('--classifier-context'),
    hooksOnly: args.includes('--hooks-only'),
    mcpOnly: args.includes('--mcp-only'),
    skillsOnly: args.includes('--skills-only'),
  };
}

function detectPackageManager(cwd: string): 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown' {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function copyFile(src: string, dest: string, flags: Flags): 'wrote' | 'skipped' | 'would-write' {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 'wrote';
}

function writeFile(dest: string, content: string, flags: Flags): 'wrote' | 'skipped' | 'would-write' {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return 'wrote';
}

function installHooks(cwd: string, flags: Flags): void {
  const templateRoot = path.join(getPackageRoot(), 'template', '.claude', 'hooks');
  if (!fs.existsSync(templateRoot)) {
    process.stderr.write(`[setup] no hook templates bundled (looked at ${templateRoot}); skipping.\n`);
    return;
  }
  const files = listFilesRecursive(templateRoot);
  process.stdout.write(`[setup] hooks:\n`);
  for (const src of files) {
    const rel = path.relative(templateRoot, src);
    const dest = path.join(cwd, '.claude', 'hooks', rel);
    const result = copyFile(src, dest, flags);
    process.stdout.write(`  ${result.padEnd(12)} .claude/hooks/${rel}\n`);
  }
}

function installSkills(cwd: string, flags: Flags): void {
  const templateRoot = path.join(getPackageRoot(), 'template', '.claude', 'skills');
  if (!fs.existsSync(templateRoot)) return;
  const files = listFilesRecursive(templateRoot);
  if (files.length === 0) return;
  process.stdout.write(`[setup] skills:\n`);
  for (const src of files) {
    const rel = path.relative(templateRoot, src);
    const dest = path.join(cwd, '.claude', 'skills', rel);
    const result = copyFile(src, dest, flags);
    process.stdout.write(`  ${result.padEnd(12)} .claude/skills/${rel}\n`);
  }
}

interface McpStanza {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpStanza>;
}

function installMcp(cwd: string, flags: Flags): void {
  const mcpPath = path.join(cwd, '.mcp.json');
  const stanza: McpStanza = {
    command: 'npx',
    args: ['-y', '@anthrorg-infra/memory-pkg', 'mcp-server'],
    env: {},
  };

  let existing: McpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      process.stderr.write(`[setup] could not parse existing .mcp.json; refusing to overwrite. Edit manually.\n`);
      return;
    }
  }
  existing.mcpServers = existing.mcpServers ?? {};

  if (existing.mcpServers['memory-pkg'] && !flags.force) {
    process.stdout.write(`[setup] mcp: skipped .mcp.json (memory-pkg server already registered; --force to overwrite)\n`);
    return;
  }

  existing.mcpServers['memory-pkg'] = stanza;
  const out = JSON.stringify(existing, null, 2) + '\n';

  if (flags.dryRun) {
    process.stdout.write(`[setup] mcp: would-write .mcp.json with memory-pkg server stanza\n`);
    return;
  }
  fs.writeFileSync(mcpPath, out, 'utf8');
  process.stdout.write(`[setup] mcp: wrote .mcp.json with memory-pkg server stanza\n`);
}

function printSettingsSnippet(): void {
  process.stdout.write(`\n[setup] settings.json — add the following hooks block to .claude/settings.json:\n`);
  process.stdout.write(`        (we do NOT edit settings.json automatically; merge by hand)\n\n`);
  const snippet = {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/memory-inject.cjs',
              timeout: 30,
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/memory-capture.cjs',
              timeout: 10,
            },
            {
              type: 'command',
              command:
                'node "$CLAUDE_PROJECT_DIR"/node_modules/@anthrorg-infra/memory-pkg/dist/cli/memory-pkg.js ingest >/dev/null 2>&1 || true',
              timeout: 30,
              async: true,
            },
          ],
        },
      ],
    },
  };
  process.stdout.write(JSON.stringify(snippet, null, 2) + '\n\n');
}

function installClassifierContext(cwd: string, flags: Flags): void {
  const destPath = path.join(cwd, '.memory-pkg', 'classifier-context.md');
  const content =
    `# Memory-pkg classifier context\n\n` +
    `This file is read by the classifier retrieval tier (currently dormant in the\n` +
    `default config) to give Haiku project-specific context when classifying\n` +
    `incoming prompts. Replace this stub with a description of your codebase:\n` +
    `repo layout, key subsystems, naming conventions, anything that helps the\n` +
    `classifier target memory lookups by subsystem and file.\n\n` +
    `## Example layout (edit me)\n\n` +
    `- \`src/api/\` — HTTP route handlers and controllers\n` +
    `- \`src/services/\` — domain services\n` +
    `- \`src/db/\` — database clients and migrations\n` +
    `- \`docs/\` — design documents\n\n` +
    `Override the path with the MEMORY_PKG_CLASSIFIER_CONTEXT_FILE env var.\n`;
  const result = writeFile(destPath, content, flags);
  process.stdout.write(`[setup] classifier-context: ${result} .memory-pkg/classifier-context.md\n`);
}

function installDocker(cwd: string, flags: Flags): void {
  const destPath = path.join(cwd, 'docker-compose.memory-pkg.yml');
  const content =
    `# Generated by 'memory-pkg setup --docker'. Edit as needed.\n` +
    `services:\n` +
    `  memory-pkg-timescale:\n` +
    `    image: timescale/timescaledb-ha:pg16\n` +
    `    container_name: memory-pkg-timescale\n` +
    `    ports:\n` +
    `      - "5432:5432"\n` +
    `    environment:\n` +
    `      POSTGRES_USER: memory-pkg\n` +
    `      POSTGRES_PASSWORD: memory-pkg-local\n` +
    `      POSTGRES_DB: memory\n` +
    `    volumes:\n` +
    `      - memory_pkg_timescale_data:/home/postgres/pgdata/data\n` +
    `    healthcheck:\n` +
    `      test: ["CMD-SHELL", "pg_isready -U memory-pkg -d memory"]\n` +
    `      interval: 10s\n` +
    `      timeout: 5s\n` +
    `      retries: 5\n` +
    `    restart: unless-stopped\n` +
    `\n` +
    `volumes:\n` +
    `  memory_pkg_timescale_data:\n`;
  const result = writeFile(destPath, content, flags);
  process.stdout.write(`[setup] docker: ${result} docker-compose.memory-pkg.yml\n`);
}

function printNextSteps(pm: string, flags: Flags): void {
  process.stdout.write(`\n[setup] Done.\n\n`);
  process.stdout.write(`Next steps:\n`);
  let step = 1;
  if (flags.docker) {
    process.stdout.write(`  ${step++}. docker compose -f docker-compose.memory-pkg.yml up -d\n`);
  } else {
    process.stdout.write(`  ${step++}. Ensure TimescaleDB is running on localhost:5432 (or set MEMORY_PKG_PG_*)\n`);
  }
  process.stdout.write(`  ${step++}. Add the hooks block (printed above) to .claude/settings.json\n`);
  process.stdout.write(`  ${step++}. npx memory-pkg schema\n`);
  process.stdout.write(`  ${step++}. Start a Claude Code session; capture, ingest, and injection are wired\n`);
  if (pm !== 'unknown') {
    process.stdout.write(`\nDetected package manager: ${pm}\n`);
  }
}

export async function runSetup(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const pm = detectPackageManager(cwd);

  process.stdout.write(`[setup] memory-pkg ${flags.dryRun ? '(dry-run)' : ''} in ${cwd}\n\n`);

  const runHooks = !flags.mcpOnly && !flags.skillsOnly;
  const runMcp = !flags.hooksOnly && !flags.skillsOnly;
  const runSkills = !flags.hooksOnly && !flags.mcpOnly;

  if (runHooks) installHooks(cwd, flags);
  if (runMcp) installMcp(cwd, flags);
  if (runSkills) installSkills(cwd, flags);
  if (flags.classifierContext) installClassifierContext(cwd, flags);
  if (flags.docker) installDocker(cwd, flags);

  if (!flags.dryRun && runHooks) printSettingsSnippet();
  if (!flags.dryRun) printNextSteps(pm, flags);

  return 0;
}
