/**
 * 0.1.0 → 0.2.0 -- Adds `.memory-pkg/config.json`.
 *
 * 0.2.0 introduces a user-editable config file that controls which model each
 * `claude -p` spawn uses (rationale synthesis, classifier tier, reranker).
 * This migration writes the file with sensible defaults if it doesn't already
 * exist, and registers it as a managed file in state.json.
 *
 * The migration is idempotent and safe to re-run: an existing config.json is
 * never overwritten (the user may have customized it). It just gets hashed and
 * tracked.
 */

import * as fs from 'fs';
import * as path from 'path';

import { defaultUserConfig, getConfigRelPath } from '../../config.js';
import { hashFile, type ManagedFile } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const migration_0_1_0_to_0_2_0: Migration = {
  from: '0.1.0',
  to: '0.2.0',
  severity: 'minor',
  description: 'Add .memory-pkg/config.json with default models for claude -p spawns',
  notes:
    'Existing installs gain a config file controlling rationale/classify/rerank ' +
    "model choices so claude -p usage can be budgeted separately. If you've " +
    'already set MEMORY_PKG_RATIONALE_MODEL or the new ' +
    'MEMORY_PKG_{CLASSIFY,RERANK}_MODEL env vars, those still win over the file.',

  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const configRel = getConfigRelPath();
    const configAbs = path.join(ctx.cwd, configRel);

    const warnings: string[] = [];
    const changedFiles: string[] = [];

    const exists = fs.existsSync(configAbs);
    if (!exists) {
      if (!ctx.dryRun) {
        fs.mkdirSync(path.dirname(configAbs), { recursive: true });
        fs.writeFileSync(
          configAbs,
          JSON.stringify(defaultUserConfig(), null, 2) + '\n',
          'utf8',
        );
      }
      changedFiles.push(configRel);
    }

    // Whether the file was just created or already present, ensure it's in
    // managedFiles. Hashing a non-existent file in dry-run mode returns ''.
    const managedFiles: ManagedFile[] = [...ctx.state.managedFiles];
    const already = managedFiles.find((f) => f.path === configRel);
    if (!already) {
      managedFiles.push({
        path: configRel,
        installedHash: ctx.dryRun ? '' : hashFile(configAbs),
      });
    }

    return { managedFiles, changedFiles, warnings };
  },
};

export default migration_0_1_0_to_0_2_0;
