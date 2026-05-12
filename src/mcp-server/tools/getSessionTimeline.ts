/**
 * getSessionTimeline.ts -- Full chronological dump of a session.
 */

import { runQuery } from '../../timescale-client.js';

export interface GetSessionTimelineInput {
  sessionId: string;
  eventType?: string;
  limit?: number;
}

interface EventRow {
  event_id: string;
  ts: string;
  event_type: string;
  tool_name: string | null;
  file_path: string | null;
  summary: string | null;
}

export async function handleGetSessionTimeline(input: GetSessionTimelineInput): Promise<string> {
  const sessionId = (input.sessionId || '').trim();
  if (!sessionId) return 'getSessionTimeline: sessionId is required.';

  const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);

  const filters: string[] = ['session_id = $1'];
  const params: unknown[] = [sessionId];
  let i = 2;

  if (input.eventType) {
    filters.push(`event_type = $${i++}`);
    params.push(input.eventType);
  }
  params.push(limit);

  const rows = await runQuery<EventRow>(
    `SELECT event_id, ts, event_type, tool_name, file_path, summary
     FROM memory_events
     WHERE ${filters.join(' AND ')}
     ORDER BY ts ASC
     LIMIT $${i}`,
    params
  );

  if (rows.length === 0) return `getSessionTimeline: no events for session ${sessionId}.`;

  const lines: string[] = [];
  lines.push(`getSessionTimeline — session ${sessionId}`);
  lines.push(`${rows.length} event(s)${input.eventType ? ` of type ${input.eventType}` : ''}`);
  lines.push('='.repeat(60));

  for (const r of rows) {
    const tool = r.tool_name ? ` · ${r.tool_name}` : '';
    const file = r.file_path ? ` · ${r.file_path}` : '';
    lines.push(`[${new Date(r.ts).toISOString()}] ${r.event_type}${tool}${file}`);
    if (r.summary) lines.push(`  ${r.summary}`);
  }

  return lines.join('\n');
}
