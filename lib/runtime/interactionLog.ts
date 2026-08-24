import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LOG_DIR = "logs";
const LOG_FILE = path.join(LOG_DIR, "interactions.jsonl");

export interface SourceRef {
  documentTitle: string;
  heading: string | null;
  citationUrl: string | null;
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
