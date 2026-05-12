/**
 * getMemoryContext.ts -- Scale forward/backward in time around an anchor event.
 */

import { runQuery } from '../../timescale-client.js';

export interface GetMemoryContextInput {
  eventId: string;
  before?: number;
  after?: number;
}

interface AnchorRow {
  event_id: string;
  ts: string;
  session_id: string;
  event_type: string;
  tool_name: string | null;
  file_path: string | null;
  summary: string | null;
}

interface WindowRow extends AnchorRow {
  relative: 'before' | 'anchor' | 'after';
}

export async function handleGetMemoryContext(input: GetMemoryContextInput): Promise<string> {
  const eventId = (input.eventId || '').trim();
  if (!eventId) return 'getMemoryContext: eventId is required (UUID from searchMemory).';

  const before = Math.min(Math.max(input.before ?? 10, 0), 100);
  const after = Math.min(Math.max(input.after ?? 10, 0), 100);

  // Find the anchor.
  const anchors = await runQuery<AnchorRow>(
    `SELECT event_id, ts, session_id, event_type, tool_name, file_path, summary
     FROM memory_events
     WHERE event_id = $1::uuid
     LIMIT 1`,
    [eventId]
  );

  if (anchors.length === 0) {
    return `getMemoryContext: no event with id ${eventId}.`;
  }

  const anchor = anchors[0];

  const beforeRows = before > 0
    ? await runQuery<AnchorRow>(
        `SELECT event_id, ts, session_id, event_type, tool_name, file_path, summary
         FROM memory_events
         WHERE session_id = $1 AND ts < $2::timestamptz
         ORDER BY ts DESC
         LIMIT $3`,
        [anchor.session_id, anchor.ts, before]
      )
    : [];

  const afterRows = after > 0
    ? await runQuery<AnchorRow>(
        `SELECT event_id, ts, session_id, event_type, tool_name, file_path, summary
         FROM memory_events
         WHERE session_id = $1 AND ts > $2::timestamptz
         ORDER BY ts ASC
         LIMIT $3`,
        [anchor.session_id, anchor.ts, after]
      )
    : [];

  const window: WindowRow[] = [
    ...beforeRows.reverse().map((r) => ({ ...r, relative: 'before' as const })),
    { ...anchor, relative: 'anchor' as const },
    ...afterRows.map((r) => ({ ...r, relative: 'after' as const })),
  ];

  const lines: string[] = [];
  lines.push(`getMemoryContext — anchor ${anchor.event_id}`);
  lines.push(`session ${anchor.session_id}`);
  lines.push(`${beforeRows.length} before, ${afterRows.length} after`);
  lines.push('='.repeat(60));

  for (const r of window) {
    const marker = r.relative === 'anchor' ? '>>>' : r.relative === 'before' ? '   ' : '   ';
    const tool = r.tool_name ? ` · ${r.tool_name}` : '';
    const file = r.file_path ? ` · ${r.file_path}` : '';
    lines.push(`${marker} [${new Date(r.ts).toISOString()}] ${r.event_type}${tool}${file}`);
    if (r.summary) lines.push(`      ${r.summary}`);
    lines.push(`      id: ${r.event_id}`);
  }

  return lines.join('\n');
}
