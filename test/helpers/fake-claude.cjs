#!/usr/bin/env node
/**
 * fake-claude.cjs -- Stand-in for the `claude` CLI in tests.
 *
 * Wire it up by setting MEMORY_PKG_CLAUDE_BIN to this file's path so
 * synthesizeRationales (src/rationale/synthesize.ts) never spawns the real
 * authenticated CLI. It ignores stdin/args, prints a canned JSON rationale to
 * stdout, and exits 0.
 */

'use strict';

process.stdout.write('Fake rationale for test turn.\n');
process.exit(0);
