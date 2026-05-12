# @anthrorg-infra/memory-pkg

**Long-term session memory for Claude Code.**

Every Claude Code session leaves a transcript JSONL on disk. `memory-pkg` reads those transcripts, indexes them in TimescaleDB, and auto-injects relevant historical events into every new user prompt. The agent stops asking the same clarifying question twice; the developer stops being the agent's notebook.

> Status: 0.1.0 — initial public release. The capture, ingestion, and SQL-only retrieval path are production-shape; semantic/classifier/KG retrieval tiers are dormant by default (see "Architecture" below). No test suite yet.

## License

`memory-pkg` is **source-available** under the [PolyForm Shield 1.0.0](./LICENSE) license. In plain English:

- ✅ You can install, use, modify, and self-host it.
- ✅ You can use it inside commercial products you ship to your own customers.
- ❌ You **cannot** use it to build a competing memory-for-coding-agents product.

If you have a use case and want clarity on whether it's permitted, open an issue.

## Install

```bash
npm install --save-dev @anthrorg-infra/memory-pkg
# or
pnpm add -D @anthrorg-infra/memory-pkg
# or
yarn add -D @anthrorg-infra/memory-pkg
```

You'll also need TimescaleDB (with `pgvector`). The setup command can write a `docker-compose.memory-pkg.yml` for you, or use any TimescaleDB instance you already have.

## Quickstart

```bash
# 1. Install package
npm install --save-dev @anthrorg-infra/memory-pkg

# 2. Run the setup command from your repo root
npx memory-pkg setup --docker

# 3. Bring up TimescaleDB
docker compose -f docker-compose.memory-pkg.yml up -d

# 4. Initialize the schema
npx memory-pkg schema

# 5. Start a Claude Code session — capture, ingest, and injection are now wired
```

`setup` installs the capture and injection hook scripts into `.claude/hooks/`, patches your `.mcp.json` with the memory-pkg MCP server stanza, copies the `temporal-recall` skill template into `.claude/skills/`, and writes a `.memory-pkg/classifier-context.md` stub if you plan to enable the classifier tier later.

Hook scripts are generated to match your detected package manager (npm/pnpm/yarn/bun).

## How it works

```
┌─ Claude Code session ────────────────────────────────┐
│   ~/.claude/projects/<sanitized-path>/<sess>.jsonl  │
└──┬──────────────────────────────────────────┬───────┘
   │ Stop hook reads tail via byte cursor     │ UserPromptSubmit
   ▼                                          │ hook (fails open)
┌─ .claude/memory/ ──────────────────────┐    │
│  buffer.jsonl                          │    │
│  cursors/<sess>.json                   │    │
└──┬─────────────────────────────────────┘    │
   │ Ingester (async after Stop)              │
   ▼                                          │
┌─ TimescaleDB memory_events hypertable ──────┴───────┐
│  GIN trigram on search_text                         │
│  HNSW cosine on embedding vector(384)               │
│  Partial index on (subsystem, ts)                   │
│  Unique on (session_id, transcript_uuid, ts)        │
└──┬──────────────────────────────────────────────────┘
   │ Multi-tier retrieval (trigram + entity, by default)
   ▼
┌─ <memory-context> block (up to 4 KB) ────────┐
│  Up to 3 prior events ranked by similarity   │
│  + recency, surfaced as additionalContext    │
└──────────────────────────────────────────────┘
```

The fast path is plain SQL trigram search against a Postgres GIN index, plus an entity tier that extracts identifiers from the prompt and the last 20 lines of the active transcript. For well-formed prompts this short-circuits the rest of the pipeline at score ≥ 0.7. The embedding, classifier, and knowledge-graph tiers exist in the code but are dormant in the default registry — flip them on by editing `src/inject/tiers/index.ts` if you fork.

## MCP tools

| Tool | What it does |
|---|---|
| `searchMemory(query, limit?, sessionId?, eventType?, since?)` | Trigram fuzzy search ranked by similarity and recency |
| `getMemoryContext(eventId, before?, after?)` | Scale forward/backward in time around an event |
| `unwindFromEvent(eventId, limit?)` | Replay every event in the session from start up to the anchor |
| `getSessionTimeline(sessionId, eventType?, limit?)` | Full chronological dump of one session |

## Rationale synthesis

`memory-pkg rationale` compresses each turn into a 2–3 sentence "why" event at ingest time, so future fuzzy searches for *"why did we change X?"* match the reasoning instead of the actions. One Haiku call per turn at ingest, amortized over every future retrieval. Uses the local `claude` CLI under Max OAuth; no API key consumed in the default setup.

Run on demand:

```bash
npx memory-pkg rationale --limit 50
```

## CLI

```bash
npx memory-pkg setup                  # one-time consumer setup
npx memory-pkg schema                 # create/update the hypertable + indexes
npx memory-pkg ingest                 # flush buffer.jsonl to TimescaleDB
npx memory-pkg search "<query>"       # fuzzy search the memory store
npx memory-pkg context <eventId>      # scale around an event
npx memory-pkg unwind <eventId>       # replay session up to an event
npx memory-pkg timeline <sessionId>   # full session dump
npx memory-pkg rationale              # synthesize turn rationales
npx memory-pkg backfill-subsystems    # re-derive subsystem tags
npx memory-pkg backfill-embeddings    # compute embeddings for legacy rows
npx memory-pkg inject "<prompt>"      # dry-run the injection pipeline
npx memory-pkg tune                   # summarize the rationale-log telemetry
```

`npx memory-pkg-mcp` runs the MCP server directly (Claude Code launches this for you via `.mcp.json`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_PKG_PG_HOST` | `localhost` | Postgres host |
| `MEMORY_PKG_PG_PORT` | `5432` | Postgres port |
| `MEMORY_PKG_PG_USER` | `memory-pkg` | DB user |
| `MEMORY_PKG_PG_PASSWORD` | `memory-pkg-local` | DB password |
| `MEMORY_PKG_PG_DATABASE` | `memory` | DB name |
| `MEMORY_PKG_REPO_ANCHOR` | (auto via `git rev-parse --show-toplevel`) | Absolute path of your repo root for subsystem derivation |
| `MEMORY_PKG_CLASSIFIER_CONTEXT_FILE` | `.memory-pkg/classifier-context.md` | Path to classifier-tier project-context prompt |
| `MEMORY_PKG_HOOK_TIMEOUT_MS` | `30000` | Injection-hook timeout (always fails open on overrun) |
| `MEMORY_PKG_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | Embedding model used by the embedding tier |
| `MEMORY_PKG_RATIONALE_MODEL` | `claude-haiku-4-5-20251001` | Model for rationale synthesis |

Legacy `DRIFT_MEMORY_*` env vars are still recognized for retrieval-tier toggles; see source for the full list.

## What this doesn't do (yet)

- Cross-project memory federation
- Continuous aggregates / compression on old TimescaleDB chunks
- Automatic embedding backfill (the helper exists but must be run deliberately)
- Test suite

## See also

- [`@anthrorg-infra/codebase-pkg`](https://github.com/jctisdale/codebase-pkg) — companion package addressing the **structural** side of agent forgetting (codebase knowledge graph). `memory-pkg` handles the **episodic** side (the work itself).
