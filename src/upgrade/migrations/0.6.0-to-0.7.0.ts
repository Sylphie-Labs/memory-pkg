/**
 * 0.6.0 → 0.7.0 -- The feedback loop (schema v3).
 *
 * What 0.7.0 adds in a consumer repo:
 *   1. `.claude/hooks/memory-rate.cjs` — a Stop hook that asks Claude to rate
 *      the memories it was injected this turn (drives the usefulness signal).
 *   2. `.claude/settings.json` — a synchronous Stop entry for that hook.
 *   3. DB schema v3 — memory_injections, memory_ratings, memory_event_stats.
 *
 * Files-first ordering: the hook + settings land before the DB write, so an
 * unreachable database degrades to a warning and leaves a re-runnable state
 * (`memory-pkg schema` applies the DDL later).
 */

import * as fs from 'fs';
import * as path from 'path';

import { installSettings } from '../../cli/init.js';
import { detectDrift, hashFile, normalizePath, type ManagedFile } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const RATE_REL = normalizePath('.claude/hooks/memory-rate.cjs');
const SCHEMA_VERSION_AT_0_7_0 = 3;

const V3_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS memory_injections (
     injection_id    UUID PRIMARY KEY,
     ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     session_id      TEXT,
     trigger         TEXT NOT NULL,
     query_or_entity TEXT,
     item_ids        UUID[] NOT NULL,
     item_kinds      TEXT[] NOT NULL,
     chars_injected  INTEGER NOT NULL DEFAULT 0,
     shadow_scores   JSONB
   );`,
  `CREATE INDEX IF NOT EXISTS idx_injections_session_ts ON memory_injections (session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS memory_ratings (
     rating_id    BIGSERIAL PRIMARY KEY,
     ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     injection_id UUID NOT NULL,
     item_id      UUID NOT NULL,
     item_kind    TEXT NOT NULL DEFAULT 'event',
     rating       SMALLINT NOT NULL CHECK (rating IN (-1, 0, 1)),
     source       TEXT NOT NULL DEFAULT 'self',
     referenced   BOOLEAN,
     session_id   TEXT
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_dedupe ON memory_ratings (injection_id, item_id, source);`,
  `CREATE INDEX IF NOT EXISTS idx_ratings_item ON memory_ratings (item_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS memory_event_stats (
     item_id       UUID PRIMARY KEY,
     item_kind     TEXT NOT NULL DEFAULT 'event',
     n_self        INTEGER NOT NULL DEFAULT 0,
     sum_self      INTEGER NOT NULL DEFAULT 0,
     n_implicit    INTEGER NOT NULL DEFAULT 0,
     sum_implicit  INTEGER NOT NULL DEFAULT 0,
     last_rated_at TIMESTAMPTZ,
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
];

const migration_0_6_0_to_0_7_0: Migration = {
  from: '0.6.0',
  to: '0.7.0',
  severity: 'minor',
  description:
    'Add the self-rating feedback loop: memory-rate.cjs Stop hook + ' +
    'memory_injections/ratings/event_stats (schema v3)',
  notes:
    'Installs the memory-rate.cjs Stop hook (asks Claude to rate injected ' +
    'memories), merges its settings entry, and creates the v3 feedback tables. ' +
    'A modified memory-rate.cjs is left as-is without --force. An unreachable ' +
    'database degrades to a warning (run `memory-pkg schema` later).',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const warnings: string[] = [];
    const changedFiles: string[] = [];
    const managedFiles: ManagedFile[] = ctx.state.managedFiles.map((f) => ({ ...f }));

    // --- 1. Install the new hook file (drift-safe). -------------------------
    const src = path.join(ctx.packageRoot, 'template', '.claude', 'hooks', 'memory-rate.cjs');
    const destAbs = path.join(ctx.cwd, RATE_REL);
    if (!fs.existsSync(src)) {
      warnings.push('bundled template for memory-rate.cjs missing; skipped.');
    } else {
      const tracked = managedFiles.find((f) => f.path === RATE_REL);
      const exists = fs.existsSync(destAbs);
      const drift = exists && tracked ? detectDrift(ctx.cwd, tracked) : exists ? 'unknown' : 'absent';
      if (exists && drift === 'modified' && !ctx.force) {
        warnings.push(
          `${RATE_REL} was modified since install; left as-is. Re-run with --force to overwrite.`,
        );
      } else {
        if (!ctx.dryRun) {
          if (exists && drift === 'modified' && ctx.force) {
            fs.copyFileSync(destAbs, `${destAbs}.bak.${Date.now()}`);
          }
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.copyFileSync(src, destAbs);
        }
        changedFiles.push(RATE_REL);
        const hash = ctx.dryRun ? '' : hashFile(destAbs);
        if (tracked) tracked.installedHash = hash;
        else managedFiles.push({ path: RATE_REL, installedHash: hash });
      }
    }

    // --- 2. Merge the settings entry. --------------------------------------
    try {
      installSettings(ctx.cwd, { force: ctx.force, dryRun: ctx.dryRun });
    } catch (err) {
      warnings.push(
        `could not merge the memory-rate hook into .claude/settings.json ` +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          `run \`memory-pkg init --hooks-only --force\` or merge by hand.`,
      );
    }

    // --- 3. Schema v3 (files-first; DB failure is non-fatal). ---------------
    if (ctx.dryRun) {
      // no DB writes on dry runs
    } else if (!ctx.runQuery) {
      warnings.push('database not configured; v3 feedback tables not created. Run `memory-pkg schema` later.');
    } else {
      try {
        for (const sql of V3_DDL) await ctx.runQuery(sql);
        await ctx.runQuery(
          `INSERT INTO memory_meta (key, value, updated_at)
           VALUES ('schema_version', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
           WHERE memory_meta.value::int < $2`,
          [String(SCHEMA_VERSION_AT_0_7_0), SCHEMA_VERSION_AT_0_7_0],
        );
      } catch (err) {
        warnings.push(
          `database unreachable or DDL failed; v3 feedback schema not applied ` +
            `(${err instanceof Error ? err.message : String(err)}). Run \`memory-pkg schema\` later.`,
        );
      }
    }

    return { managedFiles, changedFiles, warnings };
  },
};

export default migration_0_6_0_to_0_7_0;
