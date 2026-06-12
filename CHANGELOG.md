# Changelog

All notable changes to `@sylphie-labs/memory-pkg` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.1] — 2026-06-12

### Fixed
- **MCP server failed to launch (`-32000` / "Failed to reconnect").** The `.mcp.json` stanza `init` generates invokes `npx -y @sylphie-labs/memory-pkg mcp-server` — i.e. the `memory-pkg` bin with an `mcp-server` subcommand — but that subcommand didn't exist (the server lived only in the separate `memory-pkg-mcp` bin), so the process exited immediately with `unknown command: mcp-server` and none of the MCP tools (`searchMemory`, `rateMemoryInjections`, …) were ever available. Added an `mcp-server` (alias `mcp`) command to the CLI that hosts the stdio server, so the existing stanza now launches correctly — **no `.mcp.json` edit needed**, just upgrade and restart Claude Code. The server entry (`startMcpServer`) is now exported and only auto-runs when executed directly. Regression test added.

## [0.10.0] — 2026-06-12

Phase 7 — the final phase of the ambient-memory arc: the **curated hot tier** (schema v4). High-usefulness entity clusters are distilled into facts that are served as a fast-path tier above raw events.

### Added
- **`memory_facts`** (schema v4) — distilled facts (1–3 synthesized sentences) promoted from entity clusters whose memories are rated useful. Plain, mutable, consolidation-owned; a partial unique index enforces one active fact per cluster.
- **Facts retrieval tier** — trigram over fact text plus exact `cluster_key` (entity) match, active facts only. Registered in the fast path; a curated fact **outranks a raw event at equal score** (tie-break in the orchestrator). Fails soft to empty on a pre-v4 schema, so a package upgrade ahead of `memory-pkg schema` never breaks injection. Disable via `DRIFT_MEMORY_TIER_FACTS_DISABLED=1`. The ambient hook checks facts first.
- **`facts-promote`** (deep) — clusters entities with ≥3 blended ratings and mean ≥+0.6, gathers their top rationale/assistant_text excerpts, synthesizes a fact via the shared `claude -p` helper (injectable for tests), and stores it. Idempotent (skips a cluster whose active fact already covers its newest event); re-promotion supersedes the prior fact in a transaction.
- **`facts-staleness`** (deep) — retires a fact when its cluster's blended mean falls below +0.2 or the fact's own ratings go net-negative. Retired/superseded facts are never injected. Facts are themselves rateable (`item_kind='fact'`), flowing through the whole feedback pipeline unchanged.
- The `claude -p` shell-out is extracted to `src/llm/claude-cli.ts`, shared by rationale synthesis and fact promotion.

### Migration
- `0.9.0 → 0.10.0` creates `memory_facts` and its indexes (frozen idempotent DDL; degrades to a warning if the DB is unreachable). Stamps `schema_version=4`.

## [0.9.0] — 2026-06-12

Phase 6 of the ambient-memory arc: the usefulness multiplier can now go **live** — gated, opt-in, and measured first.

### Added
- **Live usefulness multiplier.** When `MEMORY_PKG_USEFULNESS_LIVE=1`, each candidate's merged score is multiplied by its usefulness multiplier (clamp 0.7–1.3) **after the merge, before the strong/ambiguous split** — never inside the tier weights (D8). Default-off: until the gate passes, the multiplier is computed and recorded as shadow but does not touch ranking, so the signal is observed before it influences retrieval.
- **`rating-mean`** consolidation processor (deep) — maintains the trailing-90-day global mean rating (μ, the positive-skew normalizer subtracted inside `usefulness()`) in `memory_meta.rating_mean`, implicit ratings at half weight.
- **`memory-pkg feedback`** — the gate report: rating distribution, rated-injection count, days of shadow data, the shadow **flip-rate** (fraction of multi-item injections the multiplier would reorder, computed from `shadow_scores`), and a GO/NO-GO against the D9 gate (≥200 rated AND ≥14 days AND flip-rate 5–40%).

### Migration
- `0.8.0 → 0.9.0` is a no-op for the consumer repo (all changes are package-side; the live flag is opt-in). No hooks, settings, or schema change.

## [0.8.0] — 2026-06-12

Phase 5 of the ambient-memory arc — the headline feature: **mid-turn ambient injection**. As Claude works (Grep/Glob/Read/Task), entities it surfaces in tool *inputs* trigger an indexed graph lookup that injects related memories right next to the tool result — including the "why" rationale of a past turn that never named the entity.

### Added
- **`memory-ambient.cjs` PostToolUse hook** (matcher `Grep|Glob|Read|Task`). Extracts entities from the tool input *in-process* (a vendored, CI-parity-tested copy of the package extractor), dedupes them against an append-only per-session ledger, and only spawns the CLI for a genuinely new entity — so the common case (a file already seen this session) costs nothing but hook startup. Caps: 2 injections/turn, 8/session. Off switch: `MEMORY_PKG_AMBIENT_DISABLED=1`. The turn boundary for the per-turn cap is marked by `memory-inject.cjs` (the only hook that sees a new prompt).
- **`memory-pkg ambient`** CLI — point-lookup over the entity graph only (no embedding/merger/rerank; a ≤5s hot path). Hybrid output: **strong** (entity has conclusion-grade content — a `turn_rationale` or `assistant_text`, including a one-hop rationale) → a compact `<ambient-memory>` block (≤2 items, ≤800 chars) recorded as an ambient injection; **weak** (entity exists but only tool-call content) → a one-line `searchMemory` hint; **empty** → nothing. Only conclusions are injected mid-turn, never raw tool calls (D15).
- **Implicit cross-check** (`referenced-check`, tick) — the near-free auditor (F4). For each injection, records an append-only `source='implicit'` rating: `referenced=true` (rating +1) if a later tool_call touched the injected memory's file or a later assistant_text mentioned its entities, else `referenced=false` (rating 0). An independent signal from self-rating, and the fallback driver if self-rating proves noisy.

### Migration
- `0.7.0 → 0.8.0` installs `memory-ambient.cjs`, re-renders `memory-inject.cjs` (now writes the turn-boundary marker), and merges the PostToolUse settings entry (with its tool matcher). No schema change — the referenced-check reuses the v3 tables.

## [0.7.0] — 2026-06-12

Phase 4 of the ambient-memory arc: the self-rating feedback loop (schema v3) — the smallest slice that closes inject → persist → rate → fold → score, on the existing prompt path, measurement-only.

### Added
- **Injection persistence.** Each real injection now writes a `memory_injections` row (what was injected, with shadow scores) and a sidecar ledger line at `.claude/memory/injections/<session>.jsonl`, and prints an `injection: <id>` line inside the `<memory-context>` block so Claude can reference it when rating. Both writes are best-effort — a DB or FS failure never breaks injection. Gated behind a `persistInjection` flag (the CLI/hook path sets it; dry-runs and tests don't persist).
- **`rateMemoryInjections` MCP tool.** Claude rates the memories it was injected (`+1` used / `0` neutral / `-1` misleading), keyed by the printed injection id. Append-only into `memory_ratings`, coerced to {−1,0,+1}, idempotent on `(injection_id, item_id, source)`; an unknown injection id is accepted (no FK, fail-open).
- **`memory-rate.cjs` Stop hook.** Zero-dependency, synchronous, never touches the DB. Reads the injection ledger and, for un-rated injections this turn, returns `{decision:"block"}` re-quoting their summaries and asking Claude to call `rateMemoryInjections`. Honors `stop_hook_active` (no loops), samples prompt-path injections (`MEMORY_PKG_RATE_SAMPLE`, default 0.25; ambient always), caps at 8 requests/session, and is a silent no-op on the common no-injection turn. Off switches: `MEMORY_PKG_RATING_DISABLED=1`, `MEMORY_PKG_RATE_SAMPLE=0`.
- **Usefulness math** (`src/feedback/usefulness.ts`, pure, exhaustively unit-tested): `u = ((sum_self + 0.5·sum_implicit)/(n_self + 0.5·n_implicit) − mu)·e^(−Δt/τ)`, τ=45d, `m = clamp(1 + 0.3·u, 0.7, 1.3)`. Decays toward neutral; the 0.7 floor is the death-spiral guard.
- **`stats-fold`** (consolidation, both cadences) recomputes `memory_event_stats` from `memory_ratings` — recompute, not increment, so it's idempotent and race-free; tick scopes to items rated in the last 7 days, deep recomputes all. **`ledger-prune`** (deep) removes ledger sidecars > 7 days old.
- **Shadow multipliers.** Each injected item's usefulness multiplier is computed and stored in `memory_injections.shadow_scores` but **not applied to ranking yet** — Phase 4 is pure measurement, so the signal can be observed before it influences retrieval (Phase 6 flips it live behind a gate).

### Migration
- `0.6.0 → 0.7.0` installs `memory-rate.cjs` (drift-safe), merges its synchronous Stop entry, and creates the v3 feedback tables (frozen DDL; degrades to a warning if the DB is unreachable). Stamps `schema_version=3`.

## [0.6.0] — 2026-06-12

Phase 3 of the ambient-memory arc: the entity graph (schema v2) — the structural B1 fix and the surface mid-turn ambient injection will stand on.

### Added
- **Entity graph** (schema v2): `memory_entities` (canonical entity, `name_norm` unique, trigram index) and `memory_entity_events` (bipartite entity↔event links, denormalized event_type/ts/session + turn anchor). Built deterministically by the new **entity-link** consolidation processor from `extractEntities()` — no LLM. Anti-join queued, budgeted, resumable; zero-entity events get a sentinel link so they leave the queue.
- **Indexed entity retrieval + one-hop associative recall.** The entity tier now resolves an entity to its `entity_id` and reads linked events straight from `memory_entity_events` (an indexed point lookup, not a hypertable scan) — biased `turn_rationale > assistant_text > rest`. It additionally surfaces the **turn rationale** of any turn a linked event belongs to, *even when the rationale text never names the entity* (entity → event → turn → rationale, via the new `idx_memory_rationale_source` expression index). Touch `FilterBar` in a grep and the turn's "why" surfaces. Falls back to the legacy `word_similarity` scan automatically when the graph isn't populated yet (fresh DB / pre-v2 schema), so existing retrieval is unchanged until the first deep pass.
- **`memory-pkg entity <name>`** — resolve an entity and list its linked events and rationales.
- `extractEntities` + `normalizeEntity` moved to `src/entities/extract.ts` (shared by the tier, the consolidation processor, and — later — the ambient hook). `src/inject/tiers/entity.ts` re-exports `extractEntities` for back-compat.

### Fixed
- **Entity-extraction noise.** `assistant_thinking` and `turn_rationale` event-type prefixes leaked from `search_text` as spurious entities; added to the stopword set. The entity-link processor now extracts from the clean `excerpt` rather than `search_text`, so tool-call input-JSON keys (`file_path`, `command`, `replace_all`, `subagent_type`, …) no longer flood the graph.

### Migration
- `0.5.1 → 0.6.0` creates the schema-v2 tables/indexes (idempotent frozen DDL; degrades to a warning if the DB is unreachable) and stamps `schema_version=2`. Run `consolidate --deep` (or just start a session) to backfill entity links from existing history.

## [0.5.1] — 2026-06-12

Phase 2 of the ambient-memory arc: the corpus-grain deep pass and the orphan-transcript sweep that fixes silent data loss (B2).

### Added
- **Deep consolidation pass** (`consolidate --deep`). Runs corpus-grain processors: the orphan-transcript sweep, an embedding backlog drain, and a cross-session rationale backlog drain. Wired as a **SessionStart** hook with `--if-stale 24`, so it runs at most once per 24h and otherwise no-ops in well under a second.
- **Orphan-transcript sweep** (B2 fix). When a terminal is killed mid-session, the per-session byte cursor never advances and every event past it is stranded — even though the transcript JSONL is intact on disk. The deep pass now compares each transcript's size against its cursor and back-captures the delta into `buffer.jsonl` (reusing the capture hook's own `processTranscript` for byte-identical parsing). A 10-minute idle gate keeps it from touching live sessions; the cursor advance plus the `(session_id, transcript_uuid, ts)` unique index make double-capture a no-op. Kill switch: `MEMORY_PKG_SWEEP_DISABLED=1`.
- **`backfillEmbeddings(batchSize, deadline?)`** is now budget-aware — it stops between batches at the deadline and the next deep pass resumes.

### Changed
- Processor registry order is now `orphan-sweep → ingest-flush → embedding-backfill → rationale (tick) → rationale-backlog (deep)`, so back-captured deltas are flushed and enriched within the same deep pass. Migration `0.5.0 → 0.5.1` adds the SessionStart hook (settings-only).

## [0.5.0] — 2026-06-12

The first phase of the ambient-memory arc: a "dream-state" consolidation entrypoint that owns all derived writes, plus the trigram-index fix that everything mid-turn will stand on. See `docs/ambient-memory-plan.md`.

### Added
- **`memory-pkg consolidate [--deep] [--if-stale H] [--budget-ms N] [--session ID]`** — the single entrypoint for all derived-write work (ingest flush, rationale synthesis, and future processors). Runs registered processors behind one shared lock (`consolidate.lock`) within an internal time budget, replacing the `ingest && rationale` Stop-hook chain. `--deep` runs the corpus-grain pass; `--if-stale H` cheaply no-ops when a deep pass ran within H hours (tracked in `memory_meta.deep_last_ran_at`).
- **Consolidation framework** (`src/consolidate/`): a `Processor` contract (idempotent, killable, resumable, anti-join-queued), a `runner` with cadence filtering (tick vs deep), per-run time budgeting, and a shared named-lock module generalized from `ingest.lock`.

### Fixed
- **Trigram/entity tiers now use the GIN index** (B1). Both tiers called `word_similarity()` as a function in `WHERE`, which forced a sequential scan of the whole `memory_events` hypertable. They now pre-filter with the index-supported `$1 <% search_text` operator (GIN-indexable via the `%>` commutator on `idx_memory_trgm`), with the exact `word_similarity(...) >= 0.2` floor kept as a recheck. `pg_trgm.word_similarity_threshold` is set to `0.2` on every pooled connection so the operator matches the retrieval floor.
- **Rationale synthesis had no concurrency lock** (B3). Rapid turns could overlap two async Stop hooks and double the `claude -p` spend; the shared `consolidate.lock` now serializes all derived-write work.
- **Consolidation budget was the hook timeout** (B4). A long session could leave a `claude -p` SIGTERM'd mid-run; the budget now lives inside the `consolidate` entrypoint, which stops launching work before the deadline and resumes on the next run via the anti-join queue.
- **Upgrade path gap 0.4.1 → 0.4.2** — added the missing no-op migration so `memory-pkg upgrade` can traverse to 0.5.0 from any 0.4.x install.

### Changed
- **`init`/upgrade settings wiring** — `installSettings` now honors a per-entry tool `matcher` and a `replaces` list (legacy command markers it supersedes). The Stop-hook entry is now `npx -y @sylphie-labs/memory-pkg consolidate`; the old `ingest && rationale` entry is stripped on upgrade. Migration `0.4.2 → 0.5.0` performs this settings swap (no schema change).

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
