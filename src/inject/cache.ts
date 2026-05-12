/**
 * cache.ts -- Disk-backed TTL cache for cross-process memoization.
 *
 * The UserPromptSubmit hook spawns a fresh node process each fire, so in-memory
 * caching doesn't help across hook calls. This cache persists under
 * .claude/memory/cache/ so repeat prompts skip expensive work (e.g. classifier
 * Haiku calls).
 *
 * Honors DRIFT_MEMORY_CACHE_DISABLED=1 to force cold reads for debugging.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class DiskTTLCache<V> {
  private memory: Map<string, CacheEntry<V>> | null = null;

  constructor(private readonly file: string, private readonly ttlMs: number) {}

  private load(): Map<string, CacheEntry<V>> {
    if (this.memory !== null) return this.memory;
    const map = new Map<string, CacheEntry<V>>();
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw) as Record<string, CacheEntry<V>>;
      const now = Date.now();
      for (const [k, v] of Object.entries(obj)) {
        if (v.expiresAt > now) map.set(k, v);
      }
    } catch {
      // missing file or parse error → empty cache
    }
    this.memory = map;
    return map;
  }

  private persist(): void {
    if (this.memory === null) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const obj: Record<string, CacheEntry<V>> = {};
      for (const [k, v] of this.memory.entries()) obj[k] = v;
      fs.writeFileSync(this.file, JSON.stringify(obj));
    } catch {
      // Non-fatal — cache is best-effort.
    }
  }

  get(key: string): V | null {
    if (process.env.DRIFT_MEMORY_CACHE_DISABLED) return null;
    const map = this.load();
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      map.delete(key);
      this.persist();
      return null;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (process.env.DRIFT_MEMORY_CACHE_DISABLED) return;
    const map = this.load();
    map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.persist();
  }
}

export function hashPrompt(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
