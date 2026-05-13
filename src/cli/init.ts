/**
 * init.ts -- `memory-pkg init` command.
 *
 * Bootstraps a consumer's project to use memory-pkg. Installs:
 *
 *   1. Hook scripts at .claude/hooks/memory-capture.cjs and memory-inject.cjs.
 *      The injection hook gets its CLI_PATH baked in at write time (the
 *      absolute path to dist/cli/memory-pkg.js of the install that ran init).
 *      This means the hook never has to shell out to `npm root -g` at fire
 *      time — fast and predictable. The MEMORY_PKG_CLI_PATH env var and a
 *      local-node_modules fallback are also honored.
 *   2. The memory-pkg MCP server stanza in .mcp.json.
 *   3. A .claude/skills/temporal-recall/SKILL.md template.
 *   4. Optionally a .memory-pkg/classifier-context.md stub
 *      (--classifier-context).
 *   5. Optionally a docker-compose.memory-pkg.yml (--docker).
 *
 * Prints a settings.json snippet to merge by hand (settings.json is usually
 * customized; we don't risk corrupting it).
 *
 * Records what was installed at .memory-pkg/state.json for upgrade/uninstall.
 *
 * Install mode: defaults to 'global' (npm i -g). Pass --local when the
 * package is a devDependency of the consumer's project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  hashFile,
  normalizePath,
  readState,
  writeState,
  type InstallMode,
  type InstallState,
  type ManagedFile,
} from '../upgrade/state.js';

type Flags = {
  dryRun: boolean;
  force: boolean;
  docker: boolean;
  classifierContext: boolean;
  hooksOnly: boolean;
  mcpOnly: boolean;
  skillsOnly: boolean;
  installMode: InstallMode;
};

function parseFlags(args: string[]): Flags {
  const local = args.includes('--local');
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    docker: args.includes('--docker'),
    classifierContext: args.includes('--classifier-context'),
    hooksOnly: args.includes('--hooks-only'),
    mcpOnly: args.includes('--mcp-only'),
    skillsOnly: args.includes('--skills-only'),
    installMode: local ? 'local' : 'global',
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

function getCliAbsolutePath(): string {
  return path.join(getPackageRoot(), 'dist', 'cli', 'memory-pkg.js');
}

function readPackageVersion(): string {
  const pkgPath = path.join(getPackageRoot(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
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

type WriteResult = 'wrote' | 'skipped' | 'would-write';

function writeFileContent(dest: string, content: string, flags: Flags): WriteResult {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return 'wrote';
}

function copyFile(src: string, dest: string, flags: Flags): WriteResult {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 'wrote';
}

/**
 * Render the memory-inject.cjs hook with the install's absolute CLI path
 * baked in. The hook still honors MEMORY_PKG_CLI_PATH and local-node_modules
 * resolution; the baked path is the final fallback.
 */
function renderInjectHook(bakedCliPath: string): string {
  const templatePath = path.join(getPackageRoot(), 'template', '.claude', 'hooks', 'memory-inject.cjs');
  const raw = fs.readFileSync(templatePath, 'utf8');

  // The template's resolveCliPath returns from MEMORY_PKG_CLI_PATH then a
  // local node_modules path. We append the baked global path as the last
  // candidate, expressed as a forward-slashed string for cross-platform safety.
  const bakedForCode = JSON.stringify(normalizePath(bakedCliPath));
  return raw.replace(
    'const CLI_PATH = resolveCliPath();',
    `// Path captured at \`memory-pkg init\` time; used when neither the env var\n` +
      `// nor the local node_modules fallback resolves.\n` +
      `const BAKED_CLI_PATH = ${bakedForCode};\n` +
      `let CLI_PATH = resolveCliPath();\n` +
      `if (!CLI_PATH && fs.existsSync(BAKED_CLI_PATH)) CLI_PATH = BAKED_CLI_PATH;`,
  );
}

function installHooks(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const templateRoot = path.join(getPackageRoot(), 'template', '.claude', 'hooks');
  if (!fs.existsSync(templateRoot)) {
    process.stderr.write(`[init] no hook templates bundled; skipping.\n`);
    return;
  }

  process.stdout.write(`[init] hooks:\n`);

  // memory-capture.cjs: straight copy.
  const captureSrc = path.join(templateRoot, 'memory-capture.cjs');
  const captureRel = normalizePath(path.join('.claude', 'hooks', 'memory-capture.cjs'));
  const captureDest = path.join(cwd, captureRel);
  const captureResult = copyFile(captureSrc, captureDest, flags);
  process.stdout.write(`  ${captureResult.padEnd(12)} ${captureRel}\n`);
  if (captureResult === 'wrote' || (captureResult === 'skipped' && fs.existsSync(captureDest))) {
    managed.push({ path: captureRel, installedHash: hashFile(captureDest) });
  }

  // memory-inject.cjs: render with baked CLI path.
  const injectRel = normalizePath(path.join('.claude', 'hooks', 'memory-inject.cjs'));
  const injectDest = path.join(cwd, injectRel);
  let injectResult: WriteResult;
  if (fs.existsSync(injectDest) && !flags.force) {
    injectResult = 'skipped';
  } else if (flags.dryRun) {
    injectResult = 'would-write';
  } else {
    const rendered = renderInjectHook(getCliAbsolutePath());
    fs.mkdirSync(path.dirname(injectDest), { recursive: true });
    fs.writeFileSync(injectDest, rendered, 'utf8');
    injectResult = 'wrote';
  }
  process.stdout.write(`  ${injectResult.padEnd(12)} ${injectRel}  (CLI_PATH baked: ${normalizePath(getCliAbsolutePath())})\n`);
  if (injectResult === 'wrote' || (injectResult === 'skipped' && fs.existsSync(injectDest))) {
    managed.push({ path: injectRel, installedHash: hashFile(injectDest) });
  }
}

function installSkills(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const templateRoot = path.join(getPackageRoot(), 'template', '.claude', 'skills');
  if (!fs.existsSync(templateRoot)) return;
  const files = listFilesRecursive(templateRoot);
  if (files.length === 0) return;
  process.stdout.write(`[init] skills:\n`);
  for (const src of files) {
    const rel = path.relative(templateRoot, src);
    const destRel = normalizePath(path.join('.claude', 'skills', rel));
    const dest = path.join(cwd, destRel);
    const result = copyFile(src, dest, flags);
    process.stdout.write(`  ${result.padEnd(12)} ${destRel}\n`);
    if (result === 'wrote' || (result === 'skipped' && fs.existsSync(dest))) {
      managed.push({ path: destRel, installedHash: hashFile(dest) });
    }
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

function installMcp(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const mcpRel = '.mcp.json';
  const mcpPath = path.join(cwd, mcpRel);

  const stanza: McpStanza =
    flags.installMode === 'local'
      ? {
          command: 'node',
          args: ['./node_modules/@sylphie-labs/memory-pkg/dist/mcp-server/index.js'],
          env: {},
        }
      : {
          command: 'npx',
          args: ['-y', '@sylphie-labs/memory-pkg', 'mcp-server'],
          env: {},
        };

  let existing: McpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      process.stderr.write(`[init] could not parse existing .mcp.json; refusing to overwrite. Edit manually.\n`);
      return;
    }
  }
  existing.mcpServers = existing.mcpServers ?? {};

  if (existing.mcpServers['memory-pkg'] && !flags.force) {
    process.stdout.write(`[init] mcp: skipped ${mcpRel} (memory-pkg server already registered; --force to overwrite)\n`);
    if (fs.existsSync(mcpPath)) {
      managed.push({ path: mcpRel, installedHash: hashFile(mcpPath) });
    }
    return;
  }

  existing.mcpServers['memory-pkg'] = stanza;
  const out = JSON.stringify(existing, null, 2) + '\n';

  if (flags.dryRun) {
    process.stdout.write(`[init] mcp: would-write ${mcpRel} with memory-pkg server stanza\n`);
    return;
  }
  fs.writeFileSync(mcpPath, out, 'utf8');
  process.stdout.write(`[init] mcp: wrote ${mcpRel} with memory-pkg server stanza\n`);
  managed.push({ path: mcpRel, installedHash: hashFile(mcpPath) });
}

function printSettingsSnippet(): void {
  process.stdout.write(`\n[init] settings.json — add the following hooks block to .claude/settings.json:\n`);
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
              command: 'npx -y @sylphie-labs/memory-pkg ingest >/dev/null 2>&1 || true',
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

function installClassifierContext(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const destRel = normalizePath(path.join('.memory-pkg', 'classifier-context.md'));
  const destPath = path.join(cwd, destRel);
  const content =
    `# Memory-pkg classifier context\n\n` +
    `Read by the classifier retrieval tier (dormant by default) to give Haiku\n` +
    `project-specific context when classifying incoming prompts. Replace this\n` +
    `stub with a description of your codebase: repo layout, key subsystems,\n` +
    `naming conventions — anything that helps target memory retrieval.\n\n` +
    `## Example layout (edit me)\n\n` +
    `- \`src/api/\` — HTTP route handlers and controllers\n` +
    `- \`src/services/\` — domain services\n` +
    `- \`src/db/\` — database clients and migrations\n` +
    `- \`docs/\` — design documents\n\n` +
    `Override the path with the MEMORY_PKG_CLASSIFIER_CONTEXT_FILE env var.\n`;
  const result = writeFileContent(destPath, content, flags);
  process.stdout.write(`[init] classifier-context: ${result} ${destRel}\n`);
  if (result === 'wrote' || (result === 'skipped' && fs.existsSync(destPath))) {
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
  }
}

function installDocker(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const destRel = 'docker-compose.memory-pkg.yml';
  const destPath = path.join(cwd, destRel);
  const content =
    `# Generated by 'memory-pkg init --docker'. Edit as needed.\n` +
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
  const result = writeFileContent(destPath, content, flags);
  process.stdout.write(`[init] docker: ${result} ${destRel}\n`);
  if (result === 'wrote' || (result === 'skipped' && fs.existsSync(destPath))) {
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
  }
}

function printNextSteps(pm: string, mode: InstallMode, didDocker: boolean): void {
  process.stdout.write(`\n[init] Done.\n\n`);
  process.stdout.write(`Next steps:\n`);
  let n = 1;
  if (didDocker) {
    process.stdout.write(`  ${n++}. docker compose -f docker-compose.memory-pkg.yml up -d\n`);
  } else {
    process.stdout.write(`  ${n++}. Ensure TimescaleDB is running on localhost:5432 (or set MEMORY_PKG_PG_*)\n`);
  }
  process.stdout.write(`  ${n++}. Merge the printed settings.json snippet into .claude/settings.json\n`);
  if (mode === 'local') {
    process.stdout.write(`  ${n++}. npx memory-pkg schema\n`);
  } else {
    process.stdout.write(`  ${n++}. memory-pkg schema\n`);
  }
  process.stdout.write(`  ${n++}. Start a Claude Code session; capture, ingest, and injection are wired\n`);
  process.stdout.write(`\nInstall mode: ${mode}${pm !== 'unknown' ? `   |   package manager: ${pm}` : ''}\n`);
}

export async function runInit(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const pm = detectPackageManager(cwd);

  process.stdout.write(`[init] memory-pkg ${flags.dryRun ? '(dry-run) ' : ''}in ${cwd}\n\n`);

  const existing = readState(cwd);
  if (existing && !flags.force) {
    process.stderr.write(
      `[init] state.json already exists for this repo (version ${existing.version}).\n` +
        `       Use 'memory-pkg upgrade' to update an existing install, or pass --force to re-init.\n`,
    );
    return 1;
  }

  const managed: ManagedFile[] = [];

  const runHooks = !flags.mcpOnly && !flags.skillsOnly;
  const runMcp = !flags.hooksOnly && !flags.skillsOnly;
  const runSkills = !flags.hooksOnly && !flags.mcpOnly;

  if (runHooks) installHooks(cwd, flags, managed);
  if (runMcp) installMcp(cwd, flags, managed);
  if (runSkills) installSkills(cwd, flags, managed);
  if (flags.classifierContext) installClassifierContext(cwd, flags, managed);
  if (flags.docker) installDocker(cwd, flags, managed);

  if (!flags.dryRun) {
    const now = new Date().toISOString();
    const state: InstallState = {
      version: readPackageVersion(),
      installedAt: now,
      lastUpgradedAt: now,
      installMode: flags.installMode,
      cliPathAtInstall: getCliAbsolutePath(),
      managedFiles: managed,
    };
    writeState(cwd, state);
    process.stdout.write(`[init] wrote .memory-pkg/state.json (tracks ${managed.length} managed file${managed.length === 1 ? '' : 's'})\n`);
  }

  if (!flags.dryRun && runHooks) printSettingsSnippet();
  if (!flags.dryRun) printNextSteps(pm, flags.installMode, flags.docker);

  return 0;
}
