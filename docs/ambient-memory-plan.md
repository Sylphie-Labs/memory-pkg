# Ambient Memory + Dream-State Consolidation — Implementation Plan

**Status:** APPROVED FOR EXECUTION — decisions final
**Author:** Mythos (deciding architect), 2026-06-12
**Baseline:** `@sylphie-labs/memory-pkg` 0.4.2, `SCHEMA_VERSION = 1` (`src/schema.ts:19`)

This is the plan of record. Every fork left open by prior reviews is decided here.
Sections: organizing principle → phase breakdown → decision register → schema plan →
dependency graph → explicit cuts → risks & rollback.

---

## 0. Organizing principle (non-negotiable invariants)

1. **Waking path = reads + raw appends only.** Hooks and the inject pipeline may read the
   DB and append rows (`memory_events` via buffer, `memory_injections`, `memory_ratings`).
   They never UPDATE, never aggregate, never synthesize.
2. **Every derived write lives in a consolidation processor**: idempotent, killable at any
   instant, resumable, queued by **anti-join** (the pattern `findTurnsWithoutRationale`
   already uses at `src/rationale/synthesize.ts:66-81` — `NOT EXISTS` against the derived
   row, never a timestamp watermark, because derived rows land with past timestamps).
3. **Budgets live inside the entrypoint**, not in the hook timeout. A processor checks its
   deadline between small units of work and exits cleanly; the next tick resumes.
4. **One consolidation lock.** Tick and deep pass are mutually exclusive, generalizing
   `acquireLock`/`ingest.lock` (`src/ingest/ingester.ts:43-64`).
5. **Everything fails open.** No hook may ever block a turn, lose a prompt, or require the
   DB to be up. Worst case is always "no memory this turn."
6. **`memory_events` stays append-only.** Usefulness, ratings, stats, facts all live in
   separate plain tables. No mutable columns on the hypertable.

---

## 1. Phase breakdown

Seven phases. Each is independently shippable, independently valuable, and gated by a
concrete acceptance check. Versions assume the existing migration registry pattern
(`src/upgrade/migrations/index.ts`) — one file-level migration per phase, named
`<from>-to-<to>.ts`, plus idempotent DDL appended to `src/schema.ts` STATEMENTS with a
`SCHEMA_VERSION` bump where noted.

### Phase 1 — `memory-pkg consolidate`: the dream-state skeleton (v0.5.0)

**Fixes B3 (duplicate Haiku spend) and B4 (SIGTERM'd mid-run), plus the B1 quick win.**

**Goal.** One entrypoint owning all derived writes, with internal budgets and a shared
lock. Replace the `npx ingest && npx rationale` Stop chain.

**New files**
- `src/consolidate/types.ts` — the processor contract:
  ```ts
  export interface ProcessorContext {
    sessionId?: string;           // present on tick, absent on deep
    deadline: number;             // epoch ms; check between units of work
    deep: boolean;
    log: (line: string) => void;  // appends to .claude/memory/consolidate-log.jsonl
  }
  export interface ProcessorResult { processed: number; skipped: number; exhausted: boolean; }
  export interface Processor {
    name: string;
    cadence: 'tick' | 'deep' | 'both';
    run(ctx: ProcessorContext): Promise<ProcessorResult>;
  }
  ```
- `src/consolidate/lock.ts` — `acquireNamedLock(dir, name, staleMs)` / `releaseNamedLock`,
  a straight generalization of `acquireLock` in `src/ingest/ingester.ts:43-64` (O_EXCL
  create, stale-break). Lock file: `.claude/memory/consolidate.lock`, stale at 15 min for
  tick, 45 min for deep. `ingester.ts` is refactored to call it (keeping `ingest.lock`
  for direct `memory-pkg ingest` back-compat).
- `src/consolidate/runner.ts` — `runConsolidation({ deep, sessionId, budgetMs })`:
  acquire lock → run registered processors in order → each processor gets
  `min(remainingBudget, perProcessorCap)` → release lock. Logs one JSONL line per
  processor to `.claude/memory/consolidate-log.jsonl`.
- `src/consolidate/processors/ingest-flush.ts` — wraps existing `ingest()` (embeddings
  for the new batch already happen inside `insertBatchReal` via `computeEmbeddings`,
  `src/ingest/ingester.ts:128-152` — no separate tick embedding step needed).
- `src/consolidate/processors/rationale.ts` — wraps `synthesizeRationales({ sessionId,
  limit: 3 })`. Per-turn cap of 3 for the current session; budget-aware (checks
  `ctx.deadline` between turns — requires a small change to `synthesizeRationales` to
  accept an optional `deadline` and return early).

**Changed files**
- `src/cli/memory-pkg.ts` — new command:
  `consolidate [--deep] [--if-stale <hours>] [--budget-ms N] [--session ID]`.
  Default tick budget **90 000 ms** (under the 120 s hook timeout with margin).
- `src/inject/tiers/trigram.ts:51-60` and `src/inject/tiers/entity.ts:186-193` — **B1
  quick win**: switch the WHERE clause to the index-supported operator form:
  ```sql
  WHERE $1 <% search_text
    AND word_similarity($1, search_text) >= $min
  ```
  `<%` is GIN-indexable against `idx_memory_trgm` (`src/schema.ts:73`); the function call
  survives only in SELECT/ORDER BY, computed for index-matched rows only.
- `src/timescale-client.ts` — `pool.on('connect', c => c.query("SET pg_trgm.word_similarity_threshold = 0.2"))`
  so the `<%` operator matches our existing 0.2 floor (default GUC is 0.6, too strict).
- `src/cli/init.ts` `desiredSettingsHooks()` (L280-312) — the Stop entry
  `npx -y @sylphie-labs/memory-pkg ingest && npx -y @sylphie-labs/memory-pkg rationale --limit 20`
  becomes `npx -y @sylphie-labs/memory-pkg consolidate` (timeout 120, async true,
  marker `memory-pkg consolidate`).
- New migration `src/upgrade/migrations/0.4.2-to-0.5.0.ts` — with `--force`, removes the
  old `memory-pkg ingest` marker entry from settings.json and merges the consolidate
  entry (reuse `installSettings`); without `--force`, warns. No DDL.

**DB.** No schema change. `SCHEMA_VERSION` stays 1.

**Acceptance check.**
1. Two concurrent `memory-pkg consolidate` runs → exactly one does work, the other prints
   `skipped: locked` and exits 0.
2. Seed 30 unrationalized turns, run `consolidate --budget-ms 5000` → exits cleanly in
   ≲6 s with partial progress; re-run completes the rest (anti-join resumability proven).
3. `EXPLAIN (ANALYZE)` on the trigram tier SQL shows `Bitmap Index Scan on idx_memory_trgm`
   per chunk instead of seq scans, and tier latency drops measurably in the
   `DRIFT_MEMORY_LOG_PATH` trace.

---

### Phase 2 — Deep pass + orphan transcript sweep (v0.5.1)

**Fixes B2 (data loss on killed terminals).**

**Goal.** `consolidate --deep` exists, is corpus-grain, and is triggered automatically
but cheaply.

**New files**
- `src/consolidate/processors/orphan-sweep.ts` (deep) — enumerate
  `~/.claude/projects/<sanitizeProjectPath(CLAUDE_PROJECT_DIR)>/*.jsonl`, compare file
  size against `.claude/memory/cursors/<session-id>.json` byteOffsets. For any transcript
  with `size > cursor.byteOffset` **and mtime older than 10 minutes** (not a live
  session), back-capture the delta and advance the cursor. Implementation reuses the
  capture logic verbatim: `createRequire(import.meta.url)` against the **bundled**
  template — `memory-capture.cjs` already exports `processTranscript`, `appendEvents`,
  `sanitizeProjectPath` via `module.exports` (template/.claude/hooks/memory-capture.cjs:331-341).
  Cursor files are plain `{byteOffset}` JSON; the sweep reads/writes them directly.
  Captured deltas go through the normal buffer → ingest-flush path (raw append, then the
  same tick processors enrich them).
- `src/consolidate/processors/embedding-backfill.ts` (deep) — wraps existing
  `backfillEmbeddings`, budget-aware batches.
- `src/consolidate/processors/rationale-backlog.ts` (deep) — `synthesizeRationales({ limit: 20 })`
  with no session filter (the existing anti-join finds cross-session stragglers).

**Changed files**
- `src/consolidate/runner.ts` — deep pass: record `deep_last_ran_at` in `memory_meta` on
  completion; `--if-stale <hours>` reads it and no-ops (exit 0, <1 s) when fresh.
  Deep default budget **10 min**.
- `src/cli/init.ts` `desiredSettingsHooks()` — add SessionStart entry
  (marker `consolidate --deep`):
  `npx -y @sylphie-labs/memory-pkg consolidate --deep --if-stale 24` — timeout 600,
  async true. **Decision: SessionStart-with-staleness-guard, no cron/scheduler** (see D7).
- Migration `0.5.0-to-0.5.1.ts` — settings.json merge of the SessionStart hook.

**DB.** No schema change.

**Acceptance check.** Copy a real transcript JSONL into the projects dir with a cursor
file whose byteOffset is 0 and an old mtime → `consolidate --deep` ingests the delta
exactly once (re-run inserts 0 — the `(session_id, transcript_uuid, ts)` unique index at
`src/schema.ts:102` plus the advanced cursor both hold), and `--if-stale 24` immediately
after no-ops.

---

### Phase 3 — Entity graph: the structural B1 fix (v0.6.0, schema v2)

**Goal.** Deterministic bipartite entity↔event index enabling (a) indexed point-lookup
retrieval for the entity tier today and the ambient hook later, (b) one-hop associative
recall entity → events → turn → rationale.

**New DB objects (appended to `src/schema.ts` STATEMENTS, `SCHEMA_VERSION = 2`)** — see §3
for full DDL: `memory_entities`, `memory_entity_events`, plus an expression index on
`memory_events ((payload->>'source_user_prompt_id')) WHERE event_type = 'turn_rationale'`
to make the turn→rationale hop indexed.

**Decision (D11): no `memory_turns` table.** The `user_prompt` event row *is* the turn
record — rationale rows already point at it via `payload->>'source_user_prompt_id'`
(`src/rationale/synthesize.ts:214,228-235`). `memory_entity_events` carries a
`turn_user_prompt_id` column instead. One less table, same hop.

**New files**
- `src/entities/extract.ts` — `extractEntities` and its regex/stopword machinery **move**
  here from `src/inject/tiers/entity.ts:44-117` (entity.ts re-exports for compat). Add
  `normalizeEntity(s) = s.trim().toLowerCase()` — the single canonical normalization used
  by the table, the ledger, and the ambient hook.
- `src/consolidate/processors/entity-link.ts` (cadence `both`) — anti-join queue: select
  events (excerpt/search_text present, `event_type <> 'tool_result'`) with
  `NOT EXISTS (SELECT 1 FROM memory_entity_events l WHERE l.event_id = e.event_id)`
  **and** `NOT EXISTS` against a small `memory_entity_nolink` exclusion… *no* —
  simpler and still anti-join-safe: events with zero extracted entities get a sentinel
  row `(entity_id = '00000000-0000-0000-0000-000000000000', event_id)` so they leave the
  queue. Tick scope: current session; deep scope: whole corpus (budgeted, eventually
  complete backfill). Per event: `extractEntities(search_text ?? excerpt)`, upsert
  `memory_entities` by `name_norm` (`ON CONFLICT (name_norm) DO UPDATE last_seen,
  event_count = event_count + 1`), insert link rows with the turn anchor (computed with
  the same windowing query `findTurnsWithoutRationale` uses: latest prior `user_prompt`
  in session).

**Changed files**
- `src/inject/tiers/entity.ts` — `queryEntity` (L165-196) becomes a two-step indexed
  lookup: (1) resolve entity → `memory_entities` by exact `name_norm`, falling back to
  `name_norm % $1` similarity ≥ 0.4 over the (tiny) entities trigram index; (2) join
  `memory_entity_events → memory_events` by `(entity_id, event_ts DESC)`, biased
  `turn_rationale > assistant_text > rest`, excluding `tool_result`. Score: 1.0 exact ×
  the existing transcript-only dampening; similarity score when fuzzy. The old
  full-table `word_similarity` scan survives only as a fallback when the entity tables
  are empty (fresh DB before first deep pass) — gated on a cheap
  `SELECT 1 FROM memory_entities LIMIT 1` probe cached per process.
- `src/cli/memory-pkg.ts` — debug command `memory-pkg entity <name>` (resolve + list
  linked events + linked rationales). Cheap and makes acceptance testable.
- Migration `0.5.1-to-0.6.0.ts` — runs the frozen v2 DDL (idempotent, degrade-to-warning
  on unreachable DB per the established `MigrationContext.runQuery` contract,
  `src/upgrade/migrations/types.ts:24-33`); deep pass backfills links afterwards.

**Acceptance check.** After one session + one `consolidate --deep`:
`memory-pkg entity merger.ts` returns linked events and their turn rationales;
`EXPLAIN` on the new entity-tier SQL shows only index scans; entity tier warm latency
< 50 ms; injection output shape unchanged (existing inject E2E tests still green).

---

### Phase 4 — Injection persistence + self-rating loop, F2 + F3-shadow (v0.7.0, schema v3)

**Goal.** Close the feedback loop on the *existing* prompt-path injection: every
injection is persisted, the model is asked to rate what it was given, ratings are
folded into per-event stats, and the usefulness multiplier is computed **in shadow**
from day one. This is the smallest end-to-end slice that proves the loop closes.

**New DB objects (`SCHEMA_VERSION = 3`)**: `memory_injections`, `memory_ratings`,
`memory_event_stats` — full DDL in §3.

**New files**
- `src/feedback/record-injection.ts` — `recordInjection({sessionId, trigger,
  queryOrEntity, items, charsInjected, shadowScores}) → injection_id`. Generates the
  UUID in-process (`crypto.randomUUID()`), INSERTs the row, and appends a sidecar line to
  `.claude/memory/injections/<session_id>.jsonl` containing
  `{injection_id, ts, items: [{item_id, item_kind, summary120}]}`. Both writes are raw
  appends (waking-path legal); each is independently best-effort try/catch — a DB
  failure must not kill the injection, and the ledger alone is enough for the rating
  hook (D16).
- `template/.claude/hooks/memory-rate.cjs` — Stop hook, **synchronous**, zero-DB:
  1. Honor `stop_hook_active` → exit 0 immediately (no loops).
  2. Read the session's injection ledger; collect entries not yet marked
     `rating_requested` — if none, exit 0 (no injections this turn → no block).
  3. Apply sampling: ambient-trigger entries always; prompt-trigger entries at
     `MEMORY_PKG_RATE_SAMPLE` (default **0.25**); session cap **8** rating requests (D17).
  4. Emit `{decision: "block", reason}` where reason re-quotes each injected item's
     120-char summary with its `injection_id`/`item_id` (cap 1 200 chars) and instructs:
     "rate via `rateMemoryInjections({injection_id, ratings:[{event_id, rating}]})`,
     −1 misleading/wrong, 0 unused/neutral, +1 used/helpful, then finish your reply."
  5. Mark entries `rating_requested` in the ledger (consumed whether or not the model
     complies — unrated items are simply never rated; F4 covers them).
- `src/mcp-server/tools/rateMemoryInjections.ts` — handler + registration in the `TOOLS`
  array and dispatch switch of `src/mcp-server/index.ts:30-126`. Coerces ratings to
  {−1,0,+1} (`>0→1, <0→−1, else 0`), inserts `memory_ratings` rows with
  `source='self'`, `ON CONFLICT (injection_id, item_id, source) DO NOTHING` (idempotent
  retries). Unknown injection_id is accepted and stored — append-only, fail-open (D18).
- `src/consolidate/processors/stats-fold.ts` (cadence `both`) — **recompute, don't
  increment** (D10): tick recomputes `memory_event_stats` rows for every `item_id`
  appearing in `memory_ratings` from the last 7 days; deep recomputes the whole table
  from scratch. Idempotent by construction; rating volume is tiny, so full GROUP BY is
  cheap. No watermark anywhere.
- `src/feedback/usefulness.ts` — pure functions:
  `usefulness(stats, now, mu)` = `((sum_self + 0.5*sum_implicit)/(n_self + 0.5*n_implicit) − mu) * exp(−Δt/τ)`,
  `Δt = now − last_rated_at`, τ = 45 d, and
  `multiplier(u) = clamp(1 + 0.3*u, 0.7, 1.3)`. `mu` is the observed global mean rating
  (positive-skew normalizer), read from `memory_meta['rating_mean']`, default 0 until
  Phase 6 populates it. Unit-tested exhaustively.

**Changed files**
- `src/inject/generate.ts` — at the `fetchEventsByIds` seam (L117-126): LEFT JOIN
  `memory_event_stats` so each EventRow carries `(n_self, sum_self, n_implicit,
  sum_implicit, last_rated_at)`. After `formatInjectBlock` (L319-322), compute shadow
  multipliers for the included rows and call `recordInjection(trigger='prompt',
  shadowScores)`. **No ranking change in this phase** — shadow only (D8). Add one line
  inside the `<memory-context>` block: `injection: <injection_id>` so the model can
  reference it when rating.
- `template/.claude/hooks/memory-inject.cjs` — after a successful injection, also resets
  the ambient per-turn counter in the ledger (forward prep for Phase 5 turn boundaries,
  D14) — a 3-line file write.
- `src/cli/init.ts` `desiredSettingsHooks()` — add Stop entry for `memory-rate.cjs`
  (timeout 10, sync, marker `memory-rate.cjs`). `installHooks` copies the new template.
- `src/consolidate/processors/ledger-prune.ts` (deep) — delete ledger files older than 7 d.
- Migration `0.6.0-to-0.7.0.ts` — frozen v3 DDL + hook install + settings merge.

**Acceptance check (the loop-closing E2E).** In a live session: a prompt triggers
injection → `memory_injections` row exists with the same `injection_id` printed in the
context block → Stop produces a block whose reason quotes the injected summaries → calling
`rateMemoryInjections` writes `memory_ratings` rows → next `consolidate` tick populates
`memory_event_stats` → `memory_injections.shadow_scores` on the *next* injection of that
event shows a non-1.0 multiplier. Plus: a turn with no injection produces no block, and
`stop_hook_active: true` never re-blocks.

---### Phase 5 — Mid-turn ambient injection (F1) + implicit cross-check (F4) (v0.8.0)

**Goal.** The headline feature: PostToolUse ambient recall, trigram/point-lookup only,
with the in-process prefilter so the common case never spawns a process. Plus the
near-free `referenced` auditor, which matters most for exactly these injections.

**New files**
- `template/.claude/hooks/memory-ambient.cjs` — PostToolUse hook, matcher
  `Grep|Glob|Read|Task`:
  1. Parse `tool_input` only (**not** `tool_response` — D1/cut): `pattern`, `query`,
     `path`, `file_path`, `prompt`, `description` fields.
  2. **In-process prefilter** (no spawn): extract entities with a vendored copy of the
     extraction regexes + `normalizeEntity` (D2: vendored block delimited by
     `// BEGIN/END GENERATED-PARITY` markers; a unit test requires the template and
     asserts output-identity with `src/entities/extract.ts` over a fixture corpus —
     drift fails CI, not production). For `Read`, the file path itself and its basename
     are entities.
  3. Dedup against the session ledger `.claude/memory/ambient/<session_id>.json`:
     key = `normalizeEntity(entity)`, session-scoped (D3). Entities already probed
     (injected, hinted, or **empty** — negative cache) are skipped. Enforce caps:
     ≤ 2 injections/turn (counter reset by memory-inject.cjs at prompt time), ≤ 8
     ambient injections/session, exit 0 instantly when capped.
  4. If genuinely new entities remain: `spawnSync` the CLI —
     `memory-pkg ambient -` with `{session_id, entities[]}` on stdin, **timeout 5 000 ms**,
     fail-open on any nonzero/timeout/missing-CLI.
  5. Emit `hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext}` with
     the CLI's stdout.
- `src/cli/ambient.ts` (wired as `ambient` subcommand) — point-lookup only, **no
  embedding tier, no merger, no rerank**: exact `name_norm` hit on `memory_entities` →
  top events via `memory_entity_events (entity_id, event_ts DESC)` biased
  `turn_rationale(3) > assistant_text(2) > other(1)`, `tool_result` and `tool_call`
  excluded from excerpt injection (D15). Hybrid push:
  - **Strong** (entity has ≥1 linked `turn_rationale`/`assistant_text` with excerpt):
    inject a compact block — header `<ambient-memory injection: <uuid>>`, ≤ 2 items,
    ≤ 800 chars total, each item carrying `event_id`, date, excerpt.
  - **Weak** (entity exists but only tool-call-grade rows): one line —
    `Past work on "<entity>" exists in long-term memory; call mcp__memory-pkg__searchMemory({query: "<entity>"}) if relevant.`
  - **Empty** (no entity row): no output; record negative-cache ledger entry.
  Writes `memory_injections (trigger='ambient')` + the injection sidecar ledger via
  `recordInjection` — so Phase 4's rating hook covers ambient automatically (always
  sampled, per D17).
- `src/consolidate/processors/referenced-check.ts` (tick) — F4. Anti-join: injections in
  this session lacking `memory_ratings (source='implicit')` rows. For each injected item:
  `referenced = true` iff, in the window from injection ts to the next `user_prompt`,
  (a) any `tool_call` event's `file_path` equals the injected item's `file_path`, or
  (b) any of the injected item's linked entities (via `memory_entity_events`) appears in
  an `assistant_text` event's `search_text`. Append rows: `source='implicit'`,
  `referenced`, `rating = referenced ? 1 : 0` (D19). Stats-fold already blends these at
  0.5 weight.

**Changed files**
- `src/cli/init.ts` — `desiredSettingsHooks()` gains the PostToolUse entry with matcher
  `Grep|Glob|Read|Task` (timeout 10, marker `memory-ambient.cjs`). `installSettings`
  (L325-393) currently only manages a `matcher: ''` group — extend it to honor a
  per-entry `matcher` when creating/locating the target group. `installHooks` copies the
  new template.
- Migration `0.7.0-to-0.8.0.ts` — hook install + settings merge. No DDL.

**Acceptance check.**
1. In a session, `Grep` for a known past entity → `<ambient-memory>` block appears
   mid-turn, ≤ 800 chars, ≤ 2 items, `injection_id` printed, row in `memory_injections`
   with `trigger='ambient'`.
2. The same Grep again → hook exits with **no CLI spawn** (assert via a debug env that
   logs spawns) and total hook wall time < 30 ms.
3. After the turn ends and a tick runs, `memory_ratings` has `source='implicit'` rows
   for the ambient injection with a correct `referenced` bit (test both arms).
4. With the DB stopped, Grep/Read latency is unchanged (prefilter never touches the DB;
   spawn only on new entities, and the CLI fails open in <5 s).

---

### Phase 6 — Usefulness multiplier goes live, F3 (v0.9.0)

**Goal.** Flip shadow → live once the gate passes, with skew normalization.

**New files**
- `src/consolidate/processors/rating-mean.ts` (deep) — compute the trailing-90-day mean
  rating (self + implicit, implicit at 0.5 weight) → `memory_meta['rating_mean']` (the
  `mu` in `usefulness.ts`). Decay-to-neutral and clamps are already in Phase 4's pure
  functions.
- `src/cli/feedback.ts` — `memory-pkg feedback`: rating distribution, n rated injections,
  shadow flip-rate (fraction of injections where the multiplier would have reordered
  `formatInjectBlock`'s included set — computable entirely from
  `memory_injections.shadow_scores`), and a printed GO/NO-GO against the gate.

**Changed files**
- `src/inject/generate.ts` — when live, multiply `candidate.score` by the multiplier
  **after `mergeCandidates` (L177) and before the strong/ambiguous split (L194-202)** —
  i.e. at the fetch seam, never inside `mergeCandidates` or tier weights (D8). Shadow
  scores keep being recorded either way (permanent audit trail).
- Rollout switch: `MEMORY_PKG_USEFULNESS_LIVE=1` opt-in at 0.9.0; default-on in the next
  minor **only if** the gate held (D9).

**Gate (D9).** ≥ 200 rated injections **and** ≥ 14 days of shadow data **and** shadow
flip-rate in the 5–40 % sanity band **and** a manual spot-check of 20 flipped orderings
shows no systematic degradation. `memory-pkg feedback` prints all four.

**Acceptance check.** Unit: multiplier math (clamps, τ-decay, mu-normalization, zero-n).
Integration: synthetic stats rows flip the ranking of a controlled injection exactly as
predicted when the env flag is set, and not at all when unset.

---

### Phase 7 — Curated hot tier, F5 (v0.10.0, schema v4)

**Goal.** Distilled, synthesized facts promoted from high-usefulness entity clusters,
served as a fast-path tier ranked above raw events at equal score.

**New DB objects (`SCHEMA_VERSION = 4`)**: `memory_facts` — DDL in §3. Plain **mutable**
table (the append-only discipline protects the hypertable; facts are derived state owned
exclusively by consolidation, low volume, and need supersession).

**New files**
- `src/consolidate/processors/facts-promote.ts` (deep) — its **own prompt and cadence**,
  not bolted onto per-turn rationale. Candidate clusters: entities whose linked items
  have `n_self + n_implicit ≥ 3` and blended mean ≥ +0.6 (computed from
  `memory_event_stats` joined through `memory_entity_events`). For each: gather top
  rationale/assistant_text excerpts (≤ 8), synthesize 1–3 declarative sentences via the
  existing `claude -p` shell-out pattern (`callClaudeCli`,
  `src/rationale/synthesize.ts:162-211`, extracted to `src/llm/claude-cli.ts` and reused),
  insert `memory_facts` with `cluster_key = name_norm`, `source_event_ids`,
  `derived_through_ts = max(source ts)`. Idempotency: the partial unique index
  (`cluster_key WHERE status='active'`) + skip when an active fact's
  `derived_through_ts` already covers the cluster's newest qualifying event.
- `src/consolidate/processors/facts-staleness.ts` (deep) — **staleness story (D12)**:
  re-promotion supersedes (old row → `status='superseded'`, `superseded_by` set) when the
  cluster has newer qualifying events; a fact is **retired** when its cluster's blended
  mean falls below +0.2 or its own fact-targeted ratings (facts are rateable items —
  `item_kind='fact'` flows through the whole Phase 4 pipeline unchanged) go net-negative.
  Retired/superseded facts never injected.
- `src/inject/tiers/facts.ts` — fast-path tier: trigram match over
  `memory_facts.search_text` (own GIN index) + entity match via `cluster_key`, active
  facts only. Registered in `getFastPathTiers()` (`src/inject/tiers/index.ts`), merger
  weight **0.35** (vs entity 0.3, trigram 0.2 — `src/inject/merger.ts:34-38`), so a fact
  outranks a raw event at equal raw score, which is exactly the promised tie-break.

**Changed files**
- `src/cli/ambient.ts` — check facts first (exact `cluster_key` hit beats raw events).
- `src/inject/generate.ts` — facts rows flow through `fetchEventsByIds` via a UNION
  (facts fetched from `memory_facts` keyed by fact_id; `RankedRow.event_type = 'fact'`,
  which `formatInjectBlock` renders fine since it only special-cases `tool_result`).
- Migration `0.9.0-to-0.10.0.ts` — frozen v4 DDL.

**Acceptance check.** Seed an entity cluster with 3 × +1 ratings → deep pass creates one
active fact; injecting a related prompt shows the fact ranked first with `[facts]`
attribution; adding newer qualifying events and re-running deep supersedes (exactly one
active fact per cluster, old one linked via `superseded_by`); driving the cluster mean
below +0.2 retires it and it stops appearing.

---

## 2. Decision register

| # | Fork | Decision | Why |
|---|------|----------|-----|
| D1 | Ambient extraction source | `tool_input` only, never `tool_response` in v1 | Inputs are short, intentional, and cheap to scan in-process; responses are huge, noisy, and would force real parsing budgets into a hot hook. |
| D2 | Prefilter entity-extraction duplication in the .cjs | Vendor the regex block into the hook template between `GENERATED-PARITY` markers + a CI parity test against `src/entities/extract.ts` | Hooks must stay zero-dependency standalone files; a bundler step is more machinery than a parity test, and drift fails CI instead of production. |
| D3 | Dedup key shape | `normalizeEntity(entity)` (lowercase, trim), **session-scoped**, with outcome memo (`injected`/`hint`/`empty` negative cache) in `.claude/memory/ambient/<session_id>.json` | Session scope bounds token cost; one ambient push per entity per session is enough — `searchMemory` covers re-query; the negative cache is what makes "common case never spawns" true. |
| D4 | B1: operator form vs bipartite table | **Both.** `<%` + GUC=0.2 in Phase 1 (two-file change, fixes prompt-path seq scans now); bipartite table in Phase 3 as the structural fix F1 stands on | The operator form keeps the existing tiers viable immediately; ambient frequency needs O(index) point lookups regardless. |
| D5 | GUC mechanism | `pool.on('connect')` `SET pg_trgm.word_similarity_threshold = 0.2` in `timescale-client.ts` | No DDL, no per-query transaction gymnastics, applies uniformly, survives DB recreation. |
| D6 | Per-turn rationale cap | 3 (tick, current session); backlog 20 (deep) | Matches spec's 2–3; deep pass guarantees eventual completeness so the tick cap is purely a latency/cost bound. |
| D7 | Deep-pass trigger | SessionStart async hook `consolidate --deep --if-stale 24`; staleness check (`memory_meta['deep_last_ran_at']`) lives in the CLI, hook always fires | Scheduling logic in one place; no cron/pg_cron dependency; cost is one short-lived no-op process per session start. |
| D8 | Multiplier seam | Post-merge, at the `fetchEventsByIds` seam (`generate.ts:177-202`), via LEFT JOIN on stats; never in `mergeCandidates`/tier weights | Tier weights encode retrieval trust; usefulness is an orthogonal posterior — conflating them makes both untunable. |
| D9 | Shadow-mode gate | ≥200 rated injections AND ≥14 days AND flip-rate 5–40 % AND manual spot-check of 20 flips; opt-in env at 0.9.0, default-on next minor | Count-based primary criterion is robust to the rating-sampling rate; the flip-rate band catches both "multiplier does nothing" and "multiplier dominates retrieval". |
| D10 | Stats maintenance | Recompute-by-affected-item (tick, 7-day lookback) + full recompute (deep); **no incremental folding, no watermark** | Bigserial/timestamp watermarks both have commit-order races; rating volume is tiny, so idempotent recompute is strictly simpler and self-healing. |
| D11 | `memory_turns` table | Cut — turn identity = anchoring `user_prompt` event_id, carried as `turn_user_prompt_id` on link rows; expression index makes the rationale hop fast | The rationale pipeline already keys turns this way (`synthesize.ts:75,228`); a turns table would be a second source of truth for the same fact. |
| D12 | Hot-tier staleness | Supersession on re-promotion + retirement on cluster mean < +0.2 or net-negative fact ratings; partial unique index enforces one active fact per cluster | Facts are derived state — regenerating beats patching; ratings-driven retirement reuses the F2/F3 machinery instead of inventing a TTL. |
| D13 | Rating scale edge cases | Coerce to {−1,0,+1}; **absence of a rating is absence, not 0**; idempotent on `(injection_id, item_id, source)`; unknown injection_id accepted | 0 = "saw it, neutral" is signal; silence is not. Append-only + DO NOTHING makes the MCP tool retry-safe. |
| D14 | Ambient per-turn boundary | `memory-inject.cjs` (fires at every user prompt) resets the ambient turn counter in the ledger | PostToolUse can't see turn boundaries; UserPromptSubmit is the turn boundary and we already own a hook there. |
| D15 | Ambient content bias | Inject only `turn_rationale`/`assistant_text` excerpts; `tool_call`-only entities downgrade to the searchMemory hint; `tool_result` never | Mid-turn context must be conclusions, not mechanics — raw tool calls mid-turn are noise at best, derailment at worst. |
| D16 | Rating hook data source | Local injection ledger sidecar only — `memory-rate.cjs` never touches the DB or spawns | Stop fires every turn; the rating prompt (re-quoted summaries) must cost microseconds and survive a dead DB. |
| D17 | Rating frequency | Ambient injections always rated; prompt-path sampled at 0.25 (`MEMORY_PKG_RATE_SAMPLE`); ≤8 requests/session | Every block costs a full extra model round-trip; prompt-path injections occur on most turns and would otherwise double turn latency and burn quota. |
| D18 | FKs on feedback tables | None | Fail-open ordering: a rating must land even when the injection row write failed; consolidation reconciles, constraints would make the waking path fragile. |
| D19 | F4 storage | Separate append-only `memory_ratings` rows, `source='implicit'`, `referenced` boolean, `rating = referenced ? 1 : 0`, blended at 0.5 weight in stats | Keeps ratings strictly append-only (no upsert onto self-rating rows), keeps the signal independently queryable as the fallback driver if self-rating proves noisy. |
| D20 | New tables: hypertable? | All plain Postgres tables; only `memory_events` stays a hypertable | Volumes are tiny (per-turn, not per-event); plain tables allow real PKs (`injection_id`, `fact_id`) that Timescale's partition-column rule would forbid. |
| D21 | Mu normalization | Global trailing-90d mean rating, deep-pass refreshed, subtracted inside `usefulness()` | Cheapest defensible answer to positive skew; per-event z-scores need more data than this system will see for months. |

---

## 3. Schema / migration plan

All DDL is appended to `STATEMENTS` in `src/schema.ts` (idempotent `IF NOT EXISTS` style,
matching the existing pattern), with `SCHEMA_VERSION` bumped per phase; each package
migration carries a **frozen copy** of the DDL it introduces (the established convention —
see `SCHEMA_VERSION_AT_0_4_0` in `src/upgrade/migrations/0.3.0-to-0.4.0.ts:51`) and
degrades to a warning when the DB is unreachable. `memory-pkg schema` always converges to
latest.

### Schema v2 (Phase 3, v0.6.0)

```sql
CREATE TABLE IF NOT EXISTS memory_entities (
  entity_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_norm    TEXT NOT NULL UNIQUE,          -- normalizeEntity() output
  display_name TEXT NOT NULL,                 -- first-seen original casing
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entities_trgm
  ON memory_entities USING GIN (name_norm gin_trgm_ops);

CREATE TABLE IF NOT EXISTS memory_entity_events (
  entity_id           UUID NOT NULL,
  event_id            UUID NOT NULL,
  event_ts            TIMESTAMPTZ NOT NULL,   -- denormalized: recency sort w/o join
  event_type          TEXT NOT NULL,          -- denormalized: bias filter w/o join
  session_id          TEXT NOT NULL,
  turn_user_prompt_id UUID,                   -- turn anchor (D11)
  PRIMARY KEY (entity_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_events_entity_ts
  ON memory_entity_events (entity_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_entity_events_event
  ON memory_entity_events (event_id);

-- entity -> turn -> rationale hop
CREATE INDEX IF NOT EXISTS idx_memory_rationale_source
  ON memory_events ((payload->>'source_user_prompt_id'))
  WHERE event_type = 'turn_rationale';
```

### Schema v3 (Phase 4, v0.7.0)

```sql
CREATE TABLE IF NOT EXISTS memory_injections (
  injection_id   UUID PRIMARY KEY,            -- generated in-process, printed in block
  ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id     TEXT NOT NULL,
  trigger        TEXT NOT NULL,               -- 'prompt' | 'ambient'
  query_or_entity TEXT,
  item_ids       UUID[] NOT NULL,
  item_kinds     TEXT[] NOT NULL,             -- parallel: 'event' | 'fact'
  chars_injected INTEGER NOT NULL,
  shadow_scores  JSONB                        -- {item_id: {merged, multiplier, effective}}
);
CREATE INDEX IF NOT EXISTS idx_injections_session_ts
  ON memory_injections (session_id, ts DESC);

CREATE TABLE IF NOT EXISTS memory_ratings (   -- APPEND-ONLY
  rating_id    BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  injection_id UUID NOT NULL,                 -- no FK (D18)
  item_id      UUID NOT NULL,
  item_kind    TEXT NOT NULL DEFAULT 'event',
  rating       SMALLINT NOT NULL CHECK (rating IN (-1, 0, 1)),
  source       TEXT NOT NULL DEFAULT 'self',  -- 'self' | 'implicit'
  referenced   BOOLEAN,                       -- implicit rows only (D19)
  session_id   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_dedupe
  ON memory_ratings (injection_id, item_id, source);
CREATE INDEX IF NOT EXISTS idx_ratings_item
  ON memory_ratings (item_id, ts DESC);

CREATE TABLE IF NOT EXISTS memory_event_stats (  -- derived; consolidation-owned
  item_id       UUID PRIMARY KEY,
  item_kind     TEXT NOT NULL DEFAULT 'event',
  n_self        INTEGER NOT NULL DEFAULT 0,
  sum_self      INTEGER NOT NULL DEFAULT 0,
  n_implicit    INTEGER NOT NULL DEFAULT 0,
  sum_implicit  INTEGER NOT NULL DEFAULT 0,
  last_rated_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Schema v4 (Phase 7, v0.10.0)

```sql
CREATE TABLE IF NOT EXISTS memory_facts (     -- plain, mutable, consolidation-owned
  fact_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_key        TEXT NOT NULL,           -- memory_entities.name_norm
  fact_text          TEXT NOT NULL,
  search_text        TEXT NOT NULL,
  source_event_ids   UUID[] NOT NULL,
  derived_through_ts TIMESTAMPTZ NOT NULL,    -- staleness anchor
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'active',  -- active|superseded|retired
  superseded_by      UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_active_cluster
  ON memory_facts (cluster_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_facts_trgm
  ON memory_facts USING GIN (search_text gin_trgm_ops);
```

Hypertable safety: nothing here touches `memory_events` except two partial/expression
indexes (v2), both legal on hypertables. No new unique constraints on the hypertable, so
the Timescale partition-column rule (already honored at `src/schema.ts:100-103`) is
never re-engaged.

---

## 4. Dependency graph & critical path

```
P1 consolidate skeleton (B3,B4) ──┬──> P2 deep pass + orphan sweep (B2)
   + <% operator fix (B1-lite)    │
                                  ├──> P3 entity graph (B1 structural)
                                  │        │
                                  └──> P4 injections + ratings + stats + shadow (F2, F3-shadow)
                                           │        │
                          P3 ──────────────┴──> P5 ambient (F1) + referenced (F4)
                                           │        │
                                           └────────┴──> P6 usefulness live (F3)
                                                              │
                                                              └──> P7 hot tier (F5)
```

- **Critical path to a closed feedback loop:** P1 → P4. That slice alone proves
  inject → persist → rate → fold → shadow-score on the *existing* prompt-path injection,
  with zero new retrieval surface and zero mid-turn risk.
- **Parallelizable:** P2 ∥ P3 ∥ P4 (all depend only on P1; touch disjoint files except
  the migration registry). P5 needs P3 + P4. P6 needs P4's data clock (≥14 d shadow), so
  it overlaps P5/P7 development naturally. P7 needs P4 schema + ideally P6 signal, but
  its promotion threshold reads raw stats, so it only hard-requires P4.
- **Why ambient (F1) lands after ratings (F2):** F1 is the highest-risk surface
  (mid-turn noise injection). Shipping the measurement loop first means every ambient
  injection is rated and cross-checked from its first day in production, and the entity
  tables it stands on (P3) get burned in by the prompt path before PostToolUse-frequency
  traffic hits them.

---

## 5. Explicit cuts (not in v1, with reasons)

1. **`tool_response` entity extraction in ambient** — unbounded input size in a
   per-tool-call hook; revisit only with evidence that input-side entities miss things.
2. **LLM entity canonicalization / fuzzy alias merging** — deterministic case-fold only.
   Alias merging without ground truth corrupts the bipartite index silently.
3. **Embedding/rescue tier in the ambient path** — model cold-start is seconds; the
   ambient budget is milliseconds. Point lookup or nothing.
4. **`memory_turns` table** — cut per D11; the `user_prompt` event is the turn.
5. **Embeddings on `memory_facts`** — facts are few and entity-keyed; trigram + cluster
   key suffice until proven otherwise.
6. **Cross-project memory** — out of scope entirely; everything stays keyed to the
   per-project DB and `.claude/memory`.
7. **External scheduler / pg_cron for the deep pass** — SessionStart-with-staleness-guard
   is sufficient and zero-dependency.
8. **Retention/compression/decay-deletion of raw events** — append forever for now;
   usefulness decay is a *ranking* concept, not a deletion policy.
9. **Rerank changes** — stays default-off, untouched (`generate.ts:209-242`).
10. **Per-item rating UI/affordances beyond the Stop block** — one mechanism, measured,
    before any second one.
11. **Facts-of-facts / hierarchy** — premature until the flat hot tier proves value.
12. **Retro-rating of pre-P4 injections from `DRIFT_MEMORY_LOG_PATH` traces** — the
    opt-in file trace stays as-is for tuning; backfilling injection rows from it buys
    little and risks double-counting.

---

## 6. Risks & rollback (per phase, all fail open)

Global invariants first: every hook exits 0 unconditionally (already the established
pattern in both templates); every spawn has a hard timeout; a missing CLI is a silent
no-op; a dead DB degrades to "no memory" (tiers already fail-soft per
`generate.ts:147-153`). Each phase additionally:

| Phase | Failure mode | Containment / rollback |
|---|---|---|
| P1 | Consolidate lock wedges (crash leaves lock) | Stale-break at 15 min (same mechanism as today's ingest.lock); worst case is delayed enrichment, never lost raw data — the buffer and transcripts persist. Rollback: re-add the old `ingest && rationale` settings entry; `consolidate` and old commands coexist (ingest.lock guards them against each other). |
| P1 | `<%` operator changes recall (GUC mismatch) | The explicit `>= $min` predicate is kept alongside `<%`, so results can only be a subset on misconfiguration, never garbage; one-line revert per tier file. |
| P2 | Orphan sweep double-ingests | Three independent guards: mtime gate, cursor advance, and the `(session_id, transcript_uuid, ts)` unique index. Sweep is deep-only; disable with `MEMORY_PKG_SWEEP_DISABLED=1`. |
| P3 | Entity link rows wrong/poisoned | Derived data: `TRUNCATE memory_entity_events, memory_entities` + deep-pass backfill rebuilds from scratch (document as the supported reset). Entity tier falls back to the legacy scan when tables are empty, so truncation is safe live. |
| P4 | Rating block annoys / loops / burns quota | `stop_hook_active` guard kills loops structurally; `MEMORY_PKG_RATE_SAMPLE=0` or `MEMORY_PKG_RATING_DISABLED=1` is an instant off-switch (hook reads env, no reinstall); injections keep recording either way, so the data layer is unaffected. |
| P4 | `recordInjection` DB write fails on hot path | try/catch around each of (DB row, ledger line); injection still emitted; ratings without injection rows are legal (D18) and reconciled by reporting, not constraints. |
| P5 | Ambient injects noise mid-turn / derails work | Caps (2/turn, 8/session, 800 chars) bound the blast radius; rationale/assistant-text-only bias (D15) bounds the content class; `MEMORY_PKG_AMBIENT_DISABLED=1` env or removing the marker-tagged settings entry kills it without touching anything else; F4 referenced-rate is the objective tripwire — if ambient referenced-rate < ~25 % after two weeks, demote strong-push to hint-only by default. |
| P5 | Prefilter regex drift vs package extractor | CI parity test (D2) fails the build; production worst case is over/under-probing, bounded by the same caps. |
| P6 | Multiplier degrades retrieval | Shadow audit trail is permanent (`shadow_scores` recorded live or not); gate (D9) precedes default-on; `MEMORY_PKG_USEFULNESS_LIVE=0` reverts instantly; clamp [0.7, 1.3] bounds worst-case damage to a 30 % score swing, which `STRONG_THRESHOLD`/`RERANK_MIN` margins absorb without dropping strong matches to zero. |
| P7 | Stale/wrong facts injected with authority | One active fact per cluster (partial unique index); facts are rateable items, so net-negative facts retire automatically; `TRUNCATE memory_facts` is a complete, safe reset (pure derived state); `DRIFT_MEMORY_TIER_FACTS_DISABLED=1` follows the existing per-tier kill-switch convention. |

---

## 7. Execution order summary

| Phase | Ver | Ships | Bugs closed | Schema |
|---|---|---|---|---|
| 1 | 0.5.0 | `consolidate` tick, lock, budgets, `<%` fix | B3, B4, B1-lite | v1 |
| 2 | 0.5.1 | `--deep`, orphan sweep, SessionStart trigger | B2 | v1 |
| 3 | 0.6.0 | Entity graph, indexed entity tier, `entity` CLI | B1 structural | v2 |
| 4 | 0.7.0 | `memory_injections`/`ratings`/`stats`, rate hook, `rateMemoryInjections` MCP, shadow multiplier | — | v3 |
| 5 | 0.8.0 | Ambient PostToolUse hook + `ambient` CLI, referenced check | — | v3 |
| 6 | 0.9.0 | Usefulness live + mu normalization + `feedback` CLI | — | v3 |
| 7 | 0.10.0 | `memory_facts`, promotion/staleness processors, facts tier | — | v4 |

Final hook surface in `.claude/settings.json` after Phase 5:
`UserPromptSubmit → memory-inject.cjs (30s)`;
`PostToolUse [Grep|Glob|Read|Task] → memory-ambient.cjs (10s)`;
`Stop → memory-capture.cjs (10s)`, `memory-rate.cjs (10s, sync)`,
`npx -y @sylphie-labs/memory-pkg consolidate (120s, async)`;
`SessionStart → npx -y @sylphie-labs/memory-pkg consolidate --deep --if-stale 24 (600s, async)`.

Note on Stop-hook concurrency: capture and consolidate race today (ingest may flush
before capture appends); that property is preserved and harmless — the tick is
idempotent and the next tick catches anything the race delays. `memory-rate.cjs` is
file-only and microsecond-fast, so its synchronous block decision is unaffected by the
others.
