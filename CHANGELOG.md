# Changelog

All notable changes to `@sylphie-labs/memory-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Removed
- **Knowledge-graph (kg) retrieval tier and the `neo4j-driver` dependency.** The tier targeted a separate `codebase-pkg` Neo4j instance that `init`/`--docker` never provisioned; it was dormant by default and pulled a heavy runtime dependency into every install.

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
