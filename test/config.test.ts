import { describe, it, expect, afterEach } from 'vitest';
import { getModelFor, getDatabaseConfig } from '../src/config.js';

// A directory with no .memory-pkg/config.json, so resolution falls to env/defaults.
const NOCFG = '/__memory_pkg_no_such_dir__';

describe('getModelFor', () => {
  afterEach(() => {
    delete process.env.MEMORY_PKG_RATIONALE_MODEL;
  });

  it('falls back to the built-in default when nothing is set', () => {
    expect(getModelFor('rationale', NOCFG)).toBe('claude-haiku-4-5-20251001');
  });

  it('prefers the env-var override', () => {
    process.env.MEMORY_PKG_RATIONALE_MODEL = 'claude-opus-4-8';
    expect(getModelFor('rationale', NOCFG)).toBe('claude-opus-4-8');
  });
});

describe('getDatabaseConfig', () => {
  afterEach(() => {
    delete process.env.MEMORY_PKG_PG_HOST;
    delete process.env.MEMORY_PKG_PG_PORT;
  });

  it('uses built-in defaults when nothing is set', () => {
    expect(getDatabaseConfig(NOCFG)).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'memory-pkg',
      password: 'memory-pkg-local',
      database: 'memory',
    });
  });

  it('env vars win and the port is parsed to a number', () => {
    process.env.MEMORY_PKG_PG_HOST = 'db.example.com';
    process.env.MEMORY_PKG_PG_PORT = '6543';
    const db = getDatabaseConfig(NOCFG);
    expect(db.host).toBe('db.example.com');
    expect(db.port).toBe(6543);
  });
});
