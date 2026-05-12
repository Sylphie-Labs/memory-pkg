# Changelog

All notable changes to `@anthrorg-infra/memory-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-12

Initial public release. Extracted from `drift-detector/packages/memory-pkg` and made repo-agnostic.

### Added
- TimescaleDB-backed `memory_events` hypertable with multi-resolution storage (`summary` / `excerpt` / `search_text` / `payload`).
- Stop-hook capture pipeline that reads the official Claude Code transcript JSONL and emits five event types: `user_prompt`, `assistant_thinking`, `assistant_text`, `tool_call`, `tool_result`.
- Buffer-and-bulk-ingest model with atomic rotation, idempotency via `(session_id, transcript_uuid, ts)` unique index, and `buffer.failed.jsonl` for failed batches.
- UserPromptSubmit injection hook that fails open on every error path.
- Multi-tier retrieval pipeline. Live tiers: trigram (GIN), entity (last 20 transcript lines + identifier extraction). Dormant: embedding (HNSW + `bge-small-en-v1.5`), classifier (Haiku via local CLI), kg (Neo4j IMPORTS expansion).
- Fast-path short-circuit at merged score ≥ 0.7.
- Rationale synthesis job that compresses each turn into a 2–3 sentence `turn_rationale` event at ingest time.
- MCP stdio server exposing four query tools: `searchMemory`, `getMemoryContext`, `unwindFromEvent`, `getSessionTimeline`.
- `memory-pkg setup` CLI command for installing hook templates, the temporal-recall skill, and patching `.mcp.json`.
- `MEMORY_PKG_*` and `DRIFT_MEMORY_*` (legacy) environment variables for Postgres connection, retrieval tier toggles, and rationale model overrides.

### Portability fixes vs. drift-detector source
- `subsystem.ts` anchor: replaced hardcoded `'/drift-detector/'` with `git rev-parse --show-toplevel` auto-detection; override via `MEMORY_PKG_REPO_ANCHOR`.
- `classify.ts` prompt: replaced hardcoded drift-detector context with config-file-driven (`.memory-pkg/classifier-context.md`); override path via `MEMORY_PKG_CLASSIFIER_CONTEXT_FILE`; generic baked-in default when neither is set.
- KG-tier Neo4j default port `7688` → `7687`.

### Known limitations
- TypeScript transcript format only (the official Claude Code JSONL).
- No automated test suite. Treat as 0.x-grade until tests land.
- Cross-project memory federation is not supported — memory is per-project.
- Continuous aggregates / compression on old TimescaleDB chunks not yet wired.
