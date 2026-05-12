/**
 * unwindFromEvent.ts -- Full chronological replay of a session up to an anchor event.
 */

import { runQuery } from '../../timescale-client.js';

export interface UnwindFromEventInput {
  eventId: string;
  limit?: number;
}

interface AnchorRow {
  event_id: string;
  ts: string;
  session_id: string;
}

interface EventRow {
  event_id: string;
  ts: string;
  event_type: string;
  tool_name: string | null;
  file_path: string | null;
  summary: string | null;
}

export async function handleUnwindFromEvent(input: UnwindFromEventInput): Promise<string> {
  const eventId = (input.eventId || '').trim();
  if (!eventId) return 'unwindFromEvent: eventId is required.';

  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);

  const anchors = await runQuery<AnchorRow>(
    `SELECT event_id, ts, session_id FROM memory_events WHERE event_id = $1::uuid LIMIT 1`,
    [eventId]
  );
  if (anchors.length === 0) return `unwindFromEvent: no event with id ${eventId}.`;

  const anchor = anchors[0];

  const rows = await runQuery<EventRow>(
    `SELECT event_id, ts, event_type, tool_name, file_path, summary
     FROM memory_events
     WHERE session_id = $1 AND ts <= $2::timestamptz
     ORDER BY ts ASC
     LIMIT $3`,
    [anchor.session_id, anchor.ts, limit]
  );

  const lines: string[] = [];
  lines.push(`unwindFromEvent — session ${anchor.session_id}`);
  lines.push(`${rows.length} event(s) from session start to anchor ${anchor.event_id}`);
  lines.push('='.repeat(60));

  for (const r of rows) {
    const isAnchor = r.event_id === anchor.event_id;
    const marker = isAnchor ? '>>>' : '   ';
    const tool = r.tool_name ? ` · ${r.tool_name}` : '';
    const file = r.file_path ? ` · ${r.file_path}` : '';
    lines.push(`${marker} [${new Date(r.ts).toISOString()}] ${r.event_type}${tool}${file}`);
    if (r.summary) lines.push(`      ${r.summary}`);
  }

  return lines.join('\n');
}
