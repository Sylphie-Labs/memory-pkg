# Changelog

All notable changes to `@sylphie-labs/memory-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.2] — 2026-06-11

### Fixed
- **Upgrade path from 0.4.0 → 0.4.1 was blocked.** The migration runner requires a registered migration for every version hop. 0.4.1 was a test-only patch release and shipped no migration, so `memory-pkg upgrade` returned "No migration from 0.4.0 to 0.4.1" and suggested `init --force` as a workaround. Added a no-op 0.4.0 → 0.4.1 migration that advances the version cursor with no file or schema changes.

## [0.4.1] — 2026-06-11

### Fixed
- **Retrieval quality: backfill embeddings.** All pre-existing events (captured before 0.3.0's embedding-at-ingest feature) had NULL vector columns, leaving the semantic rescue tier completely blind. Run `memory-pkg backfill-embeddings` after upgrading if you have a corpus predating 0.3.0.
- **0.3.0→0.4.0 upgrade migration** (was missing from the 0.4.0 release). Refreshes both hooks, auto-merges settings.json hook entries, removes `.mcp.json` from managed-file tracking, and stamps `schema_version=1`.
- **`inject` flag parsing** drop — first positional arg was silently dropped when passed after a flag; fixed in `memory-pkg.ts`.

### Added
- **Retrieval quality benchmark** (`test/integration/retrieval-quality.int.test.ts`). Seeds controlled corpora with trigram, entity, and budget cases; asserts Recall@K and MRR so regressions are detectable. Baseline: MRR=1.0, Recall=1.0 across all scored cases.
- **Test helpers**: `retrieval-score.ts` (scoreCase/scoreSuite using the rationale trace), `corpus-seeder.ts` (seedEvents + fakeEmbed vectors), `vitest.integration.config.ts` (separate DB-backed project).
- **Explicit transcript line tagging** (`userLine`/`assistantLine`) in test helpers — eliminates role-inference mis-fires for solo assistant-text turns.

## [0.4.0] — 2026-06-10

### Added
- **`ingest --retry-failed`** re-queues stranded events from `buffer.failed.jsonl` back through the normal ingest pipeline.
- **`doctor` dead-letter check** warns when `buffer.failed.jsonl` has stranded events, with the retry command in the message.
- **DB schema versioning.** `memory_meta` table records `schema_version` (currently `1`); `getSchemaVersion()` exported from `src/schema.ts`. `initSchema` is idempotent against the new table.
- **`MigrationContext.runQuery?`** — optional DB query handle wired into every migration context; migrations that need to ALTER or query the database can now do so without accessing the pool directly.
- **`installSettings`** — `init` now JSON-merges the three required hook entries into `.claude/settings.json` idempotently (marker-substring detection, `--force` replaces existing entries). Falls back to printing the snippet when the file is unparseable. Settings file is never added to `managedFiles` and never deleted on uninstall.
- **O_EXCL lockfile** (`ingest.lock`) prevents two concurrent `ingest` processes from racing on the buffer files; stale locks (>10 min) are broken automatically.

### Fixed
- **Partial-init version teleport.** `init --mcp-only --force` (and `--hooks-only`, `--skills-only`) no longer stamps the CLI version into `state.json` — `state.version` (the migration cursor) is preserved from the existing state, so `upgrade` still sees pending migrations.
- **`installedHash` baseline corruption.** When `init` adopts a pre-existing file without overwriting it, it now records the hash of the bundled template (not the user's file) as `installedHash`. Drift detection is now honest: a customized hook reads as `modified` instead of `unchanged`, so future migrations warn/skip instead of silently clobbering it.
- **Atomic `writeState`.** `writeState` now writes to a `state.json.tmp-<pid>-<ts>` file and renames atomically. A crash mid-write can no longer leave a truncated `state.json`.
- **Per-migration state persistence.** `applyAll` calls `persistState` after each successful migration. A crash mid-chain (e.g. migration 2 of 3 throws) now resumes from the last completed step on re-run instead of replaying from the original version.
- **`rotateBuffer` race closed.** Uses `renameSync` (atomic detach from the buffer path) instead of read-then-unlink. Hook appends that race the rotation now land in a fresh buffer file and are never lost. Orphaned `.rotating` temps from a prior crash are recovered on entry.
- **`insertBatch` Postgres parameter limit.** Events now chunked at 4,285 per statement (4,285 × 14 cols = 59,990, under the 65,535 bind-parameter cap). Large crash-recovery batches or long sessions no longer dead-letter silently.
- **`compareVersions` prerelease handling.** `0.3.0` now correctly compares greater than `0.3.0-rc.1`; the downgrade guard no longer fires backwards after an rc install.
- **`tool_use` payload cap.** Tool inputs (file writes, heredocs) now capped at 8,000 chars, mirroring the existing `tool_result` cap. Oversized inputs stored as `{ input_truncated: true, input_preview: "<first 8000 chars>" }`.
- **`memory-inject.cjs` Windows argv limit.** Prompt is now passed to `inject` via stdin with the `-` sentinel instead of as an argv element. Avoids the ~32KB `CreateProcess` command-line cap that was silently disabling injection for long pasted prompts.
- **`.mcp.json` out of `managedFiles`.** Adding other MCP servers to `.mcp.json` no longer causes perpetual `modified` drift warnings. The stanza presence is validated by `doctor`'s `checkMcpStanza`; hash tracking adds no value and uninstall must never delete a shared file.

### Changed
- Hook commands in `settings.json` now use relative paths (`node .claude/hooks/memory-inject.cjs`) instead of `"$CLAUDE_PROJECT_DIR"` shell expansion — cross-platform, works under cmd.exe.
- `Stop`-hook ingest+rationale command drops the POSIX-only `>/dev/null 2>&1 || true` redirection (async hook; output is not surfaced to the user anyway).
- `inject` CLI case now parses flags from `[arg, ...rest]` (the old `parseFlags(rest)` silently dropped the first flag); positional `-` explicitly triggers stdin read.
- Memory overflow instruction softened from `REQUIRED: you MUST call searchMemory` to an advisory suggestion.

### Removed
- `cursor.lastUuid` from the capture-hook cursor state. Only `byteOffset` drives resumption; `lastUuid` was populated but never read. Old cursor files (with the field) load cleanly.

## [0.3.0] — 2026-06-10

### Fixed
- **Silent event loss on multi-event transcript lines.** Events parsed from a single transcript line (assistant text + multiple `tool_use` blocks, parallel tool calls, or multiple `tool_result` blocks) shared one `transcript_uuid`/`ts` and collided on the `(session_id, transcript_uuid, ts)` unique index — all but one were dropped by `ON CONFLICT DO NOTHING`. Multi-event lines now suffix `transcript_uuid` with the block index; single-event lines keep the bare uuid for backward-compatibility.
- Rationale prompt no longer hardcodes the `drift-detector` project name; it is derived from the repo directory.
- Config cache now keys on the config-file mtime, so the long-lived MCP server picks up `.memory-pkg/config.json` edits without a restart.
- Corrected a stale MCP error hint (`pnpm neo4j:up` → docker compose) and README version/status/link drift.

### Added
- **Embeddings computed at ingest.** The ingester now embeds each non-`tool_result` event (`bge-small-en-v1.5`) into the `vector(384)` column, degrading to `NULL` (never dropping the event) on embedding failure.
- **Semantic retrieval is live.** The embedding tier is promoted to the rescue slot — it runs an HNSW cosine KNN only when the lexical fast path is weak (merged score < 0.7).
- **Automatic rationale synthesis.** The `Stop`-hook snippet chains `rationale` after `ingest`, so "why" events are created in the background after every session stop (previously manual-only).
- Centralized Postgres connection resolution (`getDatabaseConfig`): env vars > `.memory-pkg/config.json` `database` block > defaults, shared across CLI, hooks, MCP server, and doctor.
- `inject-errors.log` diagnostic trail plus a `doctor` inject-path check that surfaces otherwise-silent retrieval failures.
- Entity tier dampens transcript-only entities (weight 0.6) so recent debugging context doesn't crowd out the actual question.
- `MEMORY_PKG_EMBED_MODEL` is now honored (in addition to the legacy `DRIFT_MEMORY_EMBED_MODEL`).
- **`0.2.0 → 0.3.0` upgrade migration** that re-installs the fixed `memory-capture.cjs` (drift-safe, backs up modified hooks under `--force`) and warns that the rationale Stop-hook step must be re-merged into `settings.json`.
- **`doctor` rationale-wiring check** that inspects `.claude/settings.json`/`settings.local.json` and warns when the `Stop` hook doesn't chain `rationale`.
- **Test suite (vitest).** Initial coverage for `extractEntities`, `computeEmbeddings` (skip/fallback), `getModelFor`/`getDatabaseConfig` resolution, `deriveSubsystem`, and `toVectorLiteral`. Run with `npm test`.

### Removed
- **Knowledge-graph (kg) retrieval tier and the `neo4j-driver` dependency.** The tier targeted a separate `codebase-pkg` Neo4j instance that `init`/`--docker` never provisioned; it was dormant by default and pulled a heavy runtime dependency into every install.
- **Classifier retrieval tier** (`classify.ts`, `cache.ts`, `tiers/classifier.ts`), the `--classifier-context` init flag and its `classifier-context.md` stub, the `classify` spawn-model kind (`MEMORY_PKG_CLASSIFY_MODEL`), and the `MEMORY_PKG_CLASSIFIER_CONTEXT_FILE` setting. The tier was dormant and orphaned once the kg tier (its only downstream consumer) was removed; the embedding rescue tier now covers semantic retrieval. An existing `classifier-context.md` in a consumer repo becomes inert and can be deleted.

## [0.1.0] — 2026-05-12

Initial public release. Extracted from `drift-detector/packages/memory-pkg` and made repo-agnostic.

### Added
- TimescaleDB-backed `memory_events` hypertable with multi-resolution storage (`summary` / `excerpt` / `search_text` / `payload`).
- Stop-hook capture pipeline that reads the official Claude Code transcript JSONL and emits five event types: `user_prompt`, `assistant_thinking`, `assistant_text`, `tool_call`, `tool_result`.
- Buffer-and-bulk-ingest model with atomic rotation, idempotency via `(session_id, transcript_uuid, ts)` unique index, and `buffer.failed.jsonl` for failed batches.
- UserPromptSubmit injection hook that fails open on every error path. CLI path is baked in at init time so the global-install model works without runtime `npm root -g` lookups.
- Multi-tier retrieval pipeline. Live tiers: trigram (GIN), entity (last 20 transcript lines + identifier extraction). Dormant: embedding (HNSW + `bge-small-en-v1.5`), classifier (Haiku via local CLI), kg (Neo4j IMPORTS expansion).
- Fast-path short-circuit at merged score ≥ 0.7.
- Rationale synthesis job that compresses each turn into a 2–3 sentence `turn_rationale` event at ingest time.
- MCP stdio server exposing four query tools: `searchMemory`, `getMemoryContext`, `unwindFromEvent`, `getSessionTimeline`.
- **Lifecycle command suite**: `init`, `upgrade`, `status`, `doctor`, `uninstall`. Tracks install state in `.memory-pkg/state.json` with SHA-256 hashes per managed file. Hooks parse-checked at doctor time. Upgrades walk a migration graph from `state.version` to CLI version with explicit `--confirm`.
- **Migration framework** (`src/upgrade/`). Registry empty in 0.1.0; first migration ships with 0.2.0.
- `setup` retained as a deprecated alias to `init` through the 0.x cycle.
- `MEMORY_PKG_*` and `DRIFT_MEMORY_*` (legacy) environment variables for Postgres connection, retrieval tier toggles, rationale model overrides, and the repo-anchor / classifier-context-file overrides.

### Portability fixes vs. drift-detector source
- `subsystem.ts` anchor: replaced hardcoded `'/drift-detector/'` with `git rev-parse --show-toplevel` auto-detection; override via `MEMORY_PKG_REPO_ANCHOR`.
- `classify.ts` prompt: replaced hardcoded drift-detector context with config-file-driven (`.memory-pkg/classifier-context.md`); override path via `MEMORY_PKG_CLASSIFIER_CONTEXT_FILE`; generic baked-in default when neither is set.
- KG-tier Neo4j default port `7688` → `7687`.

### Known limitations
- TypeScript transcript format only (the official Claude Code JSONL).
- No automated test suite. Treat as 0.x-grade until tests land.
- Cross-project memory federation is not supported — memory is per-project.
- Continuous aggregates / compression on old TimescaleDB chunks not yet wired.
