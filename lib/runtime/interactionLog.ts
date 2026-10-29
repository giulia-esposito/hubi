import { emitTelemetry } from "./telemetry.ts";
import type { HistoryLog } from "./requestSession.ts";

export interface SourceRef {
  documentTitle: string;
  heading: string | null;
  citationUrl: string | null;
  /** Region label shown with the source: Global, a named region, or "not specified in source metadata". */
  regionLabel?: string;
  /** global / match / unspecified: the only statuses a source can have once it has passed the Applicability Layer. */
  regionStatus?: string;
  /** Ids for diagnosing tester feedback (chunk text is never logged). */
  chunkId?: string;
  documentId?: string;
  score?: number;
  /** "request-match" came from the pass that matched the request's wording; "facts" from the conditional fact pass. */
  pass?: "request-match" | "facts";
  /** How the Content Registry classified the document; unregistered files have no governance record. */
  governance?: "registered" | "unregistered";
  /** The registry's caveat for an Eligible with Restrictions document, shown with the source. */
  restriction?: string;
}

/** Where this turn's conversation context came from. */
export interface ContinuityLog {
  /** What the model was given as history (digest, size, last turns, what the caps dropped). */
  history?: HistoryLog;
  /** "client-history": rebuilt from the turns the browser sent (instance-independent); "instance-memory": fallback for clients that send none. */
  source: "client-history" | "instance-memory";
  /** Turns of earlier conversation available to this turn. */
  priorTurns: number;
}

/** What retrieval returned for this turn, for diagnosing wrong or missing sources. */
export interface RetrievalLog {
  /** The BM25 query (all the user's messages so far). */
  query: string;
  /** Top of the raw pass-1 ranking, before applicability filtering. */
  rawTop: { chunkId: string; documentId: string; score: number; regionScope?: string }[];
  /** Cross-language query expansion (lib/retrieval/queryExpansion.ts): whether it ran, why, and the search terms it added. */
  expansion?: { triggered: boolean; reason: string; language: string; terms: string; ms: number; error?: string };
}

/** Summary of the Applicability Layer's decision for one turn (Finding #002). */
export interface ApplicabilityLog {
  /** Operating regions detected from the user's messages (empty when unknown). */
  taskRegions: string[];
  /** Countries the user named, kept separate from the operating region. */
  taskCountries?: string[];
  mode: "none" | "notice" | "must-clarify" | "no-applicable-content";
  /** Audience groups of the eligible sources when they conflict and the user has not said which applies. */
  audienceConflict?: { audience: string[]; sources: number[] }[];
  /** Region-specific chunks withheld because the user's region was unknown (top-K window). */
  withheldCount: number;
  withheldRegions: string[];
  /** Chunks excluded because they do not apply to the user's known region (top-K window). */
  mismatchCount: number;
  mismatchRegions: string[];
  /** Sources used whose regional scope is unknown. */
  unspecifiedUsed: number;
  /** Conditional fact-retrieval pass (Finding #004). */
  factPass?: { triggered: boolean; reason: string; added: number; query?: string };
  /** Milliseconds spent in retrieval (both passes plus applicability). */
  retrievalMs?: number;
  /** Where the region in force came from: a message in the window, the pinned context, or nowhere. */
  regionSource?: "message" | "pinned" | "none";
}

export interface InteractionRecord {
  type: "interaction";
  timestamp: string;
  sessionId: string;
  interactionId: string;
  question: string;
  response: string;
  sources: SourceRef[];
  turnKind: string;
  // Task Planning V0: what kind of work was requested (model self-report).
  // Optional so records written before Task Planning V0 remain valid.
  planningMode?: string;
  /** Applicability Layer decision for this turn. Optional so older records stay valid. */
  applicability?: ApplicabilityLog;
  retrieval?: RetrievalLog;
  continuity?: ContinuityLog;
  /** The answer was buffered for the pilot claim check: nothing streamed until it was complete. */
  buffered?: boolean;
  /** Milliseconds spent in the reasoning provider (all calls, including a revision). */
  modelMs?: number;
  /** Verify-and-revise outcome, present only for turns that were buffered for verification (HUBI_VERIFY_CLAIMS=1). */
  verification?: {
    checked: boolean;
    violationsBefore: number;
    violationsAfter: number;
    revised: boolean;
    revisionAccepted: boolean;
    phrases: string[];
    extraMs: number;
    /** The first draft, kept only when a revision was attempted; the final text is `response`. */
    draft?: string;
    /** Claims-ledger outcome for the final answer (Finding #005 attribution check). */
    attribution?: { status: string; claims: number; violations: number; byType: Record<string, number> };
    /** The final answer's ledger (capped): each claim, its source number and the quoted words. */
    ledger?: { claim: string; source: number; quote: string }[];
  };
  latencyMs: number;
  /** Who made the request (user, IP); present only when HUBI_LOG_ACTOR=1. */
  actor?: { user?: string; ip?: string };
  /** Model calls made for the final response and time spent waiting between retries (provider resilience). */
  engineAttempts?: number;
  engineRetryWaitMs?: number;
  ok: boolean;
}

/** A turn that failed before an answer was produced. */
export interface InteractionErrorRecord {
  type: "interaction_error";
  timestamp: string;
  sessionId: string;
  interactionId: string;
  question: string;
  error: string;
  latencyMs: number;
  engineAttempts?: number;
  engineRetryWaitMs?: number;
  actor?: { user?: string; ip?: string };
  applicability?: ApplicabilityLog;
  retrieval?: RetrievalLog;
  continuity?: ContinuityLog;
  buffered?: boolean;
}

export interface FeedbackRecord {
  type: "feedback";
  timestamp: string;
  sessionId: string;
  interactionId: string;
  helpful: boolean;
  actor?: { user?: string; ip?: string };
  comment?: string;
  /** Pilot issue tags chosen by the tester (see lib/runtime/feedbackTags.ts). */
  tags?: string[];
  /** Milliseconds the tester waited before the first visible text appeared. */
  waitMs?: number;
  /** The answer was buffered for the pilot claim check (nothing streamed until it was complete). */
  buffered?: boolean;
}

/**
 * Interaction and feedback records go through lib/runtime/telemetry.ts: stdout
 * as structured JSON on Cloud Run (so they survive instances and restarts in
 * Cloud Logging) and the local logs/interactions.jsonl file in development.
 * Feedback is a separate record correlated by interactionId. No user identity
 * is captured: sessionId is a random UUID.
 */
export function logInteraction(record: InteractionRecord): void {
  emitTelemetry("interaction", { ...record });
}

export function logFeedback(record: FeedbackRecord): void {
  emitTelemetry("feedback", { ...record });
}

export function logInteractionError(record: InteractionErrorRecord): void {
  emitTelemetry("interaction_error", { ...record });
}
