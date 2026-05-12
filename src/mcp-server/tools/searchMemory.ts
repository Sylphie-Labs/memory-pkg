/**
 * searchMemory.ts -- Fuzzy search memory events by trigram similarity.
 */

import { runQuery } from '../../timescale-client.js';

export interface SearchMemoryInput {
  query: string;
  limit?: number;
  sessionId?: string;
  eventType?: string;
  since?: string;
}

export async function handleSearchMemory(input: SearchMemoryInput): Promise<string> {
  const query = (input.query || '').trim();
  if (!query) return 'searchMemory: empty query. Provide text to fuzzy-match against the event log.';

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  const filters: string[] = ['search_text IS NOT NULL'];
  const params: unknown[] = [query];
  let i = 2;

  if (input.sessionId) {
    filters.push(`session_id = $${i++}`);
    params.push(input.sessionId);
  }
  if (input.eventType) {
    filters.push(`event_type = $${i++}`);
    params.push(input.eventType);
  }
  if (input.since) {
    filters.push(`ts >= $${i++}::timestamptz`);
    params.push(input.since);
  }

  // word_similarity matches the query against the best word-extent inside
  // search_text — the right metric for short queries on long documents.
  // We use explicit >= (not the <% operator, whose 0.6 default threshold is
  // too aggressive for us) so the caller can tune the threshold.
  const MIN_SCORE = 0.25;
  const minScoreIdx = i++;
  params.push(MIN_SCORE);
  const limitIdx = i;
  params.push(limit);

  const sql = `
    SELECT
      event_id,
      ts,
      session_id,
      event_type,
      tool_name,
      file_path,
      summary,
      word_similarity($1, search_text) AS score
    FROM memory_events
    WHERE ${filters.join(' AND ')}
      AND word_similarity($1, search_text) >= $${minScoreIdx}
    ORDER BY score DESC, ts DESC
    LIMIT $${limitIdx}
  `;

  const rows = await runQuery<{
    event_id: string;
    ts: string;
    session_id: string;
    event_type: string;
    tool_name: string | null;
    file_path: string | null;
    summary: string | null;
    score: number;
  }>(sql, params);

  if (rows.length === 0) {
    return `searchMemory: no hits for "${query}". Try a shorter / differently-spelled term.`;
  }

  const lines: string[] = [];
  lines.push(`searchMemory — ${rows.length} hit(s) for "${query}"`);
  lines.push('='.repeat(60));
  for (const r of rows) {
    const score = (r.score * 100).toFixed(0);
    const head = `${score}% ${r.event_type}`;
    const tool = r.tool_name ? ` · ${r.tool_name}` : '';
    const file = r.file_path ? ` · ${r.file_path}` : '';
    lines.push(`\n[${head}${tool}${file}]`);
    lines.push(`  id: ${r.event_id}`);
    lines.push(`  ts: ${new Date(r.ts).toISOString()}`);
    lines.push(`  session: ${r.session_id}`);
    if (r.summary) lines.push(`  ${r.summary}`);
  }
  lines.push('\nUse getMemoryContext or unwindFromEvent with event_id to scale around a hit.');
  return lines.join('\n');
}
