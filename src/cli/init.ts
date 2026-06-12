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
 *   4. Optionally a docker-compose.memory-pkg.yml (--docker).
 *
 * JSON-merges the required hooks into .claude/settings.json (additive,
 * idempotent; falls back to printing a snippet if the file is unparseable).
 *
 * Records what was installed at .memory-pkg/state.json for upgrade/uninstall.
 *
 * Install mode: defaults to 'global' (npm i -g). Pass --local when the
 * package is a devDependency of the consumer's project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import {
  hashFile,
  normalizePath,
  readState,
  writeState,
  type InstallMode,
  type InstallState,
  type ManagedFile,
} from '../upgrade/state.js';
import { defaultUserConfig, getConfigRelPath } from '../config.js';

type Flags = {
  dryRun: boolean;
  force: boolean;
  docker: boolean;
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

/**
 * Hash content we generated/rendered in memory (the template baseline).
 * Used when an existing file is adopted without being overwritten: the
 * managed baseline must be OUR template, never the user's pre-existing
 * file, so drift detection stays honest.
 */
function hashString(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
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
export function renderInjectHook(bakedCliPath: string): string {
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
  if (captureResult === 'wrote') {
    managed.push({ path: captureRel, installedHash: hashFile(captureDest) });
  } else if (captureResult === 'skipped' && fs.existsSync(captureDest)) {
    // Adopted, not written: baseline is the bundled template, so a user file
    // that differs reads as 'modified' and upgrades will not clobber it.
    managed.push({ path: captureRel, installedHash: hashString(fs.readFileSync(captureSrc)) });
  }

  // memory-inject.cjs: render with baked CLI path.
  const injectRel = normalizePath(path.join('.claude', 'hooks', 'memory-inject.cjs'));
  const injectDest = path.join(cwd, injectRel);
  const rendered = renderInjectHook(getCliAbsolutePath());
  let injectResult: WriteResult;
  if (fs.existsSync(injectDest) && !flags.force) {
    injectResult = 'skipped';
  } else if (flags.dryRun) {
    injectResult = 'would-write';
  } else {
    fs.mkdirSync(path.dirname(injectDest), { recursive: true });
    fs.writeFileSync(injectDest, rendered, 'utf8');
    injectResult = 'wrote';
  }
  process.stdout.write(`  ${injectResult.padEnd(12)} ${injectRel}  (CLI_PATH baked: ${normalizePath(getCliAbsolutePath())})\n`);
  if (injectResult === 'wrote') {
    managed.push({ path: injectRel, installedHash: hashFile(injectDest) });
  } else if (injectResult === 'skipped' && fs.existsSync(injectDest)) {
    // Baseline = what we would have rendered for THIS install location.
    managed.push({ path: injectRel, installedHash: hashString(rendered) });
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
    if (result === 'wrote') {
      managed.push({ path: destRel, installedHash: hashFile(dest) });
    } else if (result === 'skipped' && fs.existsSync(dest)) {
      managed.push({ path: destRel, installedHash: hashString(fs.readFileSync(src)) });
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

function installMcp(cwd: string, flags: Flags): void {
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
}

type HookEntry = { type: string; command: string; timeout?: number; async?: boolean };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type HookEventName = 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'PostToolUse';

interface DesiredHook {
  event: HookEventName;
  /** Substring identifying this entry's command for idempotent detection. */
  marker: string;
  entry: HookEntry;
  /**
   * Tool matcher for the group this entry lives in (PostToolUse/PreToolUse).
   * Defaults to '' (the catch-all group we own for UserPromptSubmit/Stop/etc).
   */
  matcher?: string;
  /**
   * Legacy command markers this entry supersedes. Any existing hook whose
   * command contains one of these is removed before merging — used to retire
   * commands that an entry replaces (e.g. consolidate replaces the old
   * `ingest && rationale` Stop chain) regardless of --force.
   */
  replaces?: string[];
}

/**
 * The hook entries we want present in .claude/settings.json, with a marker
 * substring used to detect whether an equivalent entry already exists.
 * Commands are cross-platform: relative paths (hooks run with cwd = project
 * dir), no shell variable expansion, no redirects.
 */
function desiredSettingsHooks(): DesiredHook[] {
  return [
    {
      event: 'UserPromptSubmit',
      marker: 'memory-inject.cjs',
      entry: {
        type: 'command',
        command: 'node .claude/hooks/memory-inject.cjs',
        timeout: 30,
      },
    },
    {
      event: 'Stop',
      marker: 'memory-capture.cjs',
      entry: {
        type: 'command',
        command: 'node .claude/hooks/memory-capture.cjs',
        timeout: 10,
      },
    },
    {
      // The consolidation entrypoint: owns ingest + rationale (+ future
      // derived-write processors) behind one lock and internal budget.
      // Supersedes the old `ingest && rationale` Stop chain.
      event: 'Stop',
      marker: 'memory-pkg consolidate',
      replaces: ['memory-pkg ingest'],
      entry: {
        type: 'command',
        command: 'npx -y @sylphie-labs/memory-pkg consolidate',
        timeout: 120,
        async: true,
      },
    },
    {
      // Corpus-grain deep pass on session start: orphan sweep, embedding +
      // rationale backlog. --if-stale 24 makes it a cheap no-op when a deep
      // pass already ran in the last 24h, so it costs ~one short process per
      // session start.
      event: 'SessionStart',
      marker: 'consolidate --deep',
      entry: {
        type: 'command',
        command: 'npx -y @sylphie-labs/memory-pkg consolidate --deep --if-stale 24',
        timeout: 600,
        async: true,
      },
    },
  ];
}

/**
 * JSON-merge our hook entries into .claude/settings.json (same ownership
 * model as .mcp.json: shared file, additive merge, never tracked in
 * managedFiles, never deleted on uninstall).
 *
 * Idempotent: an entry is considered present when any existing hook command
 * for that event contains its marker substring. With --force, existing
 * marker-matching entries are removed first and fresh ones appended.
 * If the file exists but is not valid JSON, we refuse to touch it and fall
 * back to printing the snippet for hand-merging.
 */
export function installSettings(cwd: string, flags: Pick<Flags, 'force' | 'dryRun'>): void {
  const rel = normalizePath(path.join('.claude', 'settings.json'));
  const abs = path.join(cwd, rel);

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(abs)) {
    try {
      settings = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
    } catch {
      process.stderr.write(`[init] settings: ${rel} is not valid JSON; refusing to edit it.\n`);
      printSettingsSnippet();
      return;
    }
  }

  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<
    string,
    unknown
  >;
  settings.hooks = hooks;

  const desired = desiredSettingsHooks();
  const added: string[] = [];
  let stripped = 0;

  for (const { event, marker, entry, matcher = '', replaces } of desired) {
    let groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];

    // Markers to strip before merging: superseded legacy commands always, plus
    // our own marker when --force (so the fresh entry wins).
    const stripMarkers = [...(replaces ?? [])];
    if (flags.force) stripMarkers.push(marker);

    if (stripMarkers.length > 0) {
      let removed = 0;
      groups = groups
        .map((g) => {
          const kept = (g.hooks ?? []).filter(
            (h) =>
              !(typeof h.command === 'string' && stripMarkers.some((m) => h.command.includes(m))),
          );
          removed += (g.hooks ?? []).length - kept.length;
          return { ...g, hooks: kept };
        })
        .filter((g) => (g.hooks ?? []).length > 0);
      if (removed > 0) {
        stripped += removed;
        hooks[event] = groups;
      }
    }

    const present = groups.some((g) =>
      (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(marker)),
    );
    if (present) {
      hooks[event] = groups;
      continue;
    }

    // Append into (or create) the group with the entry's matcher.
    let target = groups.find((g) => (g.matcher ?? '') === matcher);
    if (!target) {
      target = { matcher, hooks: [] };
      groups.push(target);
    }
    target.hooks = target.hooks ?? [];
    target.hooks.push(entry);
    added.push(`${event}: ${entry.command}`);
    hooks[event] = groups;
  }

  if (added.length === 0 && stripped === 0) {
    process.stdout.write(`[init] settings: ${rel} already wired (no changes)\n`);
    return;
  }
  if (flags.dryRun) {
    process.stdout.write(
      `[init] settings: would-write ${rel} (+${added.length} hook entr${added.length === 1 ? 'y' : 'ies'}` +
        `${stripped > 0 ? `, -${stripped} superseded` : ''})\n`,
    );
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  process.stdout.write(`[init] settings: wrote ${rel}\n`);
  for (const a of added) process.stdout.write(`  added       ${a}\n`);
  if (stripped > 0) process.stdout.write(`  removed     ${stripped} superseded entr${stripped === 1 ? 'y' : 'ies'}\n`);
}

function printSettingsSnippet(): void {
  process.stdout.write(`\n[init] settings.json — merge the following hooks block into .claude/settings.json by hand:\n\n`);
  const snippet = {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: 'node .claude/hooks/memory-inject.cjs',
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
              command: 'node .claude/hooks/memory-capture.cjs',
              timeout: 10,
            },
            {
              type: 'command',
              command: 'npx -y @sylphie-labs/memory-pkg consolidate',
              timeout: 120,
              async: true,
            },
          ],
        },
      ],
    },
  };
  process.stdout.write(JSON.stringify(snippet, null, 2) + '\n\n');
}

function installUserConfig(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const destRel = getConfigRelPath();
  const destPath = path.join(cwd, destRel);
  const content = JSON.stringify(defaultUserConfig(), null, 2) + '\n';
  const result = writeFileContent(destPath, content, flags);
  process.stdout.write(`[init] config: ${result} ${destRel}\n`);
  if (result === 'wrote') {
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
  } else if (result === 'skipped' && fs.existsSync(destPath)) {
    managed.push({ path: destRel, installedHash: hashString(content) });
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
  if (result === 'wrote') {
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
  } else if (result === 'skipped' && fs.existsSync(destPath)) {
    managed.push({ path: destRel, installedHash: hashString(content) });
  }
}

function printNextSteps(pm: string, mode: InstallMode, didDocker: boolean): void {
  process.stdout.write(`\n[init] Done.\n\n`);
  process.stdout.write(`Next steps:\n`);
  let n = 1;
  if (didDocker) {
    process.stdout.write(`  ${n++}. docker compose -f docker-compose.memory-pkg.yml up -d\n`);
  } else {
    process.stdout.write(`  ${n++}. Ensure TimescaleDB is running on localhost:5432 (override host/port/creds in .memory-pkg/config.json or MEMORY_PKG_PG_*)\n`);
  }
  process.stdout.write(`  ${n++}. Verify the hooks block in .claude/settings.json (written/merged by init)\n`);
  if (mode === 'local') {
    process.stdout.write(`  ${n++}. npx memory-pkg schema\n`);
  } else {
    process.stdout.write(`  ${n++}. memory-pkg schema\n`);
  }
  process.stdout.write(`  ${n++}. Start a Claude Code session; capture, ingest, rationale, and injection are wired\n`);
  process.stdout.write(`\nModel choices for \`claude -p\` spawns and the Postgres connection live in\n`);
  process.stdout.write(`.memory-pkg/config.json (override via MEMORY_PKG_* env vars).\n`);
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

  const isPartial = flags.hooksOnly || flags.mcpOnly || flags.skillsOnly;
  const runHooks = !flags.mcpOnly && !flags.skillsOnly;
  const runMcp = !flags.hooksOnly && !flags.skillsOnly;
  const runSkills = !flags.hooksOnly && !flags.mcpOnly;

  if (runHooks) installHooks(cwd, flags, managed);
  if (runMcp) installMcp(cwd, flags);
  if (runSkills) installSkills(cwd, flags, managed);
  installUserConfig(cwd, flags, managed);
  if (flags.docker) installDocker(cwd, flags, managed);
  if (runHooks) installSettings(cwd, flags);

  if (!flags.dryRun) {
    const now = new Date().toISOString();

    // Partial runs merge into the existing managedFiles list so that sibling
    // entries (e.g. hooks when running --mcp-only) are not silently dropped.
    let finalManaged = managed;
    let installedAt = now;
    let lastUpgradedAt = now;
    // A partial run must NEVER advance state.version: that is the migration
    // cursor, and stamping the CLI version here would teleport past pending
    // migrations. Only full init (or first-ever init) stamps the CLI version.
    let version = readPackageVersion();
    if (isPartial && existing) {
      const mergedMap = new Map(existing.managedFiles.map((f) => [f.path, f]));
      for (const f of managed) {
        mergedMap.set(f.path, f);
      }
      finalManaged = [...mergedMap.values()];
      installedAt = existing.installedAt;
      lastUpgradedAt = existing.lastUpgradedAt;
      version = existing.version;
    }

    // .mcp.json is a shared, user-merged file (other MCP servers live in it
    // too). It must not be in managedFiles: hash-drift is meaningless for it
    // and uninstall must never delete it. Strip entries inherited from
    // states written by older versions.
    finalManaged = finalManaged.filter((f) => f.path !== '.mcp.json');

    const state: InstallState = {
      version,
      installedAt,
      lastUpgradedAt,
      installMode: flags.installMode,
      cliPathAtInstall: getCliAbsolutePath(),
      managedFiles: finalManaged,
    };
    writeState(cwd, state);
    process.stdout.write(`[init] wrote .memory-pkg/state.json (tracks ${finalManaged.length} managed file${finalManaged.length === 1 ? '' : 's'})\n`);
  }

  if (!flags.dryRun) printNextSteps(pm, flags.installMode, flags.docker);

  return 0;
}
