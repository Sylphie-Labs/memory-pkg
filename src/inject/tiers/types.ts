/**
 * types.ts -- Shared tier contract for memory-injection retrieval sources.
 *
 * Every tier (trigram, embedding, classifier, kg, ...) obeys the Tier
 * function signature. The orchestrator in generate.ts loads enabled tiers,
 * runs them in parallel, and feeds their TierResults into the merger.
 *
 * Tiers return event_id + score only. The orchestrator bulk-fetches full
 * event rows once at the end to avoid N queries.
 */

export interface TierInput {
  query: string;
  sessionId?: string;
  excludeSelf: boolean;
  transcriptPath?: string;  // absolute path to session JSONL; used by entity tier
}

export interface Candidate {
  event_id: string;
  score: number;         // normalized 0..1 within the tier
  source_tier: string;   // 'trigram' | 'embedding' | 'classifier' | 'kg' | 'entity'
  rationale?: string;    // optional short reason (for logging)
}

// Tier-specific side channel. Entity tier reports which entities were queried,
// which were dropped over cap, and which had more hits than surfaced so the
// orchestrator can render a "To widen" header. Other tiers may ignore it.
export interface TierMetadata {
  queried?: string[];
  dropped?: string[];
  overflow?: Record<string, number>;  // entity -> total matches when > per-entity cap
}

export interface TierResult {
  tier: string;
  candidates: Candidate[];
  latency_ms: number;
  disabled?: boolean;    // true when env-gated off; merger skips
  error?: string;        // caught error; tier degrades to empty
  metadata?: TierMetadata;
}

export type Tier = (input: TierInput) => Promise<TierResult>;
