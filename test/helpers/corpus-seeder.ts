/**
 * corpus-seeder.ts -- Seed a retrieval test corpus with real (fake) embeddings.
 *
 * Wraps the direct-INSERT seeding approach of test/helpers/db.ts but additionally
 * computes and stores the pgvector `embedding` column so the semantic embedding
 * tier has vectors to rank against. Embeddings are produced by the deterministic
 * fakeEmbed() (test/helpers/fakeEmbed.ts), which is byte-for-byte compatible with
 * the fake path of src/embed.ts (enabled via MEMORY_PKG_EMBED_FAKE) so the query
 * the tier embeds at retrieval time lands in the same buckets as seeded text.
 *
 * Each call uses a distinctive session_id prefix so multiple seeder invocations
 * in one test do not collide; event_ids (server-generated UUIDs) are read back by
 * querying the rows that carry that prefix, ordered by insertion order.
 */

import pg from 'pg';
import { randomBytes } from 'crypto';
import { fakeEmbed } from './fakeEmbed.js';
import { toVectorLiteral } from '../../src/embed.js';

const { Client } = pg;

export interface CorpusEvent {
  session_id?: string;
  event_type?: string;
  search_text: string;
  excerpt?: string;
  summary?: string;
  ts?: string;
  /** Metadata for test assertions only — never written to the DB. */
  _role?: 'gold' | 'negative' | 'noise';
}

/**
 * Seed events into the test DB with embedding vectors computed via fakeEmbed.
 *
 * Returns the inserted event_ids in insertion order plus the sessionPrefix used
 * to tag them. Each row's session_id is `${sessionPrefix}-${index}` unless the
 * event supplies its own session_id (in which case the prefix is prepended so the
 * read-back query can still find every inserted row).
 *
 * The caller must have MEMORY_PKG_EMBED_FAKE set (so the embedding tier's query
 * embedding matches these seeded vectors) and the env must point MEMORY_PKG_PG_*
 * at the test DB.
 */
export async function seedCorpus(
  env: Record<string, string>,
  events: CorpusEvent[],
  sessionPrefix?: string,
): Promise<{ eventIds: string[]; sessionPrefix: string }> {
  const prefix = sessionPrefix ?? `corpus-${randomBytes(4).toString('hex')}`;

  if (events.length === 0) {
    return { eventIds: [], sessionPrefix: prefix };
  }

  const cols = [
    'ts',
    'session_id',
    'event_type',
    'search_text',
    'excerpt',
    'summary',
    'embedding',
  ];

  const values: unknown[] = [];
  const rowPlaceholders: string[] = [];
  let p = 1;

  events.forEach((event, index) => {
    const cells: string[] = [];
    for (const col of cols) {
      switch (col) {
        case 'ts':
          if (event.ts === undefined) {
            cells.push('NOW()');
          } else {
            cells.push(`$${p++}`);
            values.push(event.ts);
          }
          break;
        case 'session_id':
          cells.push(`$${p++}`);
          values.push(
            event.session_id ? `${prefix}-${event.session_id}` : `${prefix}-${index}`,
          );
          break;
        case 'event_type':
          cells.push(`$${p++}`);
          values.push(event.event_type ?? 'assistant_text');
          break;
        case 'search_text':
          cells.push(`$${p++}`);
          values.push(event.search_text);
          break;
        case 'excerpt':
          cells.push(`$${p++}`);
          values.push(event.excerpt ?? event.search_text);
          break;
        case 'summary':
          cells.push(`$${p++}`);
          values.push(event.summary ?? '');
          break;
        case 'embedding':
          cells.push(`$${p++}::vector`);
          values.push(toVectorLiteral(fakeEmbed(event.search_text)));
          break;
      }
    }
    rowPlaceholders.push(`(${cells.join(', ')})`);
  });

  const sql =
    `INSERT INTO memory_events (${cols.join(', ')}) VALUES ` +
    rowPlaceholders.join(', ') +
    ` RETURNING event_id, session_id`;

  const client = new Client({
    host: env.MEMORY_PKG_PG_HOST,
    port: parseInt(env.MEMORY_PKG_PG_PORT, 10),
    user: env.MEMORY_PKG_PG_USER,
    password: env.MEMORY_PKG_PG_PASSWORD,
    database: env.MEMORY_PKG_PG_DATABASE,
  });
  await client.connect();
  try {
    const res = await client.query<{ event_id: string; session_id: string }>(sql, values);
    // RETURNING preserves the VALUES insertion order, so res.rows already lines
    // up index-for-index with the input events.
    const eventIds = res.rows.map((r) => r.event_id);
    return { eventIds, sessionPrefix: prefix };
  } finally {
    await client.end();
  }
}
