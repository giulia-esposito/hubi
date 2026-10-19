import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LOG_DIR = "logs";
const LOG_FILE = path.join(LOG_DIR, "interactions.jsonl");

export interface SourceRef {
  documentTitle: string;
  heading: string | null;
  citationUrl: string | null;
  /** Region label shown with the source: Global, a named region, or "not specified in source metadata". */
  regionLabel?: string;
  /** global / match / unspecified: the only statuses a source can have once it has passed the Applicability Layer. */
  regionStatus?: string;
}

/** Summary of the Applicability Layer's decision for one turn (Finding #002). */
export interface ApplicabilityLog {
  /** Regions detected from the user's messages (empty when unknown). */
  taskRegions: string[];
  mode: "none" | "notice" | "must-clarify" | "no-applicable-content";
  /** Region-specific chunks withheld because the user's region was unknown (top-K window). */
  withheldCount: number;
  withheldRegions: string[];
  /** Chunks excluded because they do not apply to the user's known region (top-K window). */
  mismatchCount: number;
  mismatchRegions: string[];
  /** Sources used whose regional scope is unknown. */
  unspecifiedUsed: number;
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
  latencyMs: number;
  ok: boolean;
}

export interface FeedbackRecord {
  type: "feedback";
  timestamp: string;
  sessionId: string;
  interactionId: string;
  helpful: boolean;
  comment?: string;
}

/**
 * Append-only JSONL log, one record per line. Feedback is a separate record
 * correlated by interactionId rather than an in-place edit of the original
 * interaction line -- simpler and safer than mutating a specific line in a
 * flat file, and a reviewer can join the two by interactionId when reading
 * the log. No personal data is captured: sessionId is a random UUID with no
 * identity attached, and nothing about the browser/user is logged beyond it.
 */
function appendRecord(record: InteractionRecord | FeedbackRecord): void {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
}

export function logInteraction(record: InteractionRecord): void {
  appendRecord(record);
}

export function logFeedback(record: FeedbackRecord): void {
  appendRecord(record);
}
