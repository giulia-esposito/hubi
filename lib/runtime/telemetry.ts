/**
 * Pilot telemetry that survives Cloud Run instances and restarts.
 *
 * On Cloud Run, one JSON object per line on stdout becomes a structured entry
 * (jsonPayload) in Cloud Logging, with no extra GCP resource, IAM grant or
 * dependency. Locally, the same entries are appended to logs/interactions.jsonl
 * as before. Telemetry must never break a request: every failure here is
 * swallowed.
 *
 * Query examples (Logs Explorer or `gcloud logging read`):
 *   jsonPayload.component="hubi" AND jsonPayload.event="feedback"
 *   jsonPayload.event="feedback" AND jsonPayload.tags="too-slow"
 *   jsonPayload.event="interaction" AND jsonPayload.verification.revised=true
 *   jsonPayload.interactionId="<id from a feedback entry>"
 * Feedback joins to its answer through interactionId; each entry carries the
 * Cloud Run service and revision, so feedback maps to a deployed build.
 *
 * Privacy: entries contain the tester's question and Hubi's answer, as the
 * local log always did. No user identity is added (no IAP email), and chunk
 * text is never logged, only chunk ids.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { BUILD_INFO } from "./buildInfo.ts";
import path from "node:path";

export type TelemetryEvent = "interaction" | "feedback" | "interaction_error" | "startup";

export const TELEMETRY_SCHEMA = "hubi-pilot-telemetry-v1";

type Env = Record<string, string | undefined>;

// Cloud Logging rejects entries over 256 KB; stay well under it.
const MAX_STRING_CHARS = 20_000;
const MAX_ENTRY_CHARS = 200_000;
const TRUNCATION_MARK = "...[truncated]";

export interface TelemetryTarget {
  stdout: boolean;
  file: boolean;
}

/** Where entries go: stdout on Cloud Run (K_SERVICE is set there) or with HUBI_LOG_STDOUT=1; the local file everywhere else. */
export function telemetryTarget(env: Env = process.env): TelemetryTarget {
  const onCloudRun = Boolean(env.K_SERVICE);
  const stdoutFlag = env.HUBI_LOG_STDOUT?.trim();
  const fileFlag = env.HUBI_LOG_FILE?.trim();
  const stdout = stdoutFlag === "0" ? false : stdoutFlag === "1" ? true : onCloudRun;
  const file = fileFlag === "0" ? false : fileFlag === "1" ? true : !onCloudRun;
  return { stdout, file };
}

/** Deeply caps string lengths so one oversized field cannot sink the whole entry. */
export function capStrings<T>(value: T, max: number): T {
  if (typeof value === "string") {
    return (value.length > max ? value.slice(0, max) + TRUNCATION_MARK : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => capStrings(v, max)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capStrings(v, max);
    return out as T;
  }
  return value;
}

function severityFor(event: TelemetryEvent, record: Record<string, unknown>): "INFO" | "WARNING" | "ERROR" {
  if (event === "interaction_error") return "ERROR";
  if (event === "interaction" && record.ok === false) return "WARNING";
  return "INFO";
}

export function buildTelemetryEntry(
  event: TelemetryEvent,
  record: Record<string, unknown>,
  env: Env = process.env,
  now: Date = new Date()
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    severity: severityFor(event, record),
    message: `hubi.${event}`,
    component: "hubi",
    event,
    schema: TELEMETRY_SCHEMA,
    // Which deployed build produced this entry; absent when running locally.
    service: env.K_SERVICE,
    revision: env.K_REVISION,
    // The exact commit that produced this entry (set by the deploy script's build).
    commit: BUILD_INFO.commit,
    provider: env.HUBI_REASONING_PROVIDER || "claude-code",
    model: env.HUBI_REASONING_PROVIDER === "gemini" ? env.HUBI_GEMINI_MODEL || "gemini-2.5-flash" : undefined,
    ...record,
  };
  if (typeof entry.timestamp !== "string") entry.timestamp = now.toISOString();

  let capped = capStrings(entry, MAX_STRING_CHARS);
  if (JSON.stringify(capped).length > MAX_ENTRY_CHARS) {
    // Still too large: shrink every string hard and say so.
    capped = capStrings(entry, 2_000);
    capped.truncated = true;
  }
  return capped;
}

export function emitTelemetry(event: TelemetryEvent, record: Record<string, unknown>, env: Env = process.env): void {
  try {
    const entry = buildTelemetryEntry(event, record, env);
    const line = JSON.stringify(entry);
    const target = telemetryTarget(env);
    if (target.stdout) process.stdout.write(line + "\n");
    if (target.file) {
      try {
        mkdirSync("logs", { recursive: true });
        appendFileSync(path.join("logs", "interactions.jsonl"), line + "\n", "utf8");
      } catch {
        // A read-only or missing filesystem must not affect the request.
      }
    }
  } catch {
    // Telemetry must never break a request.
  }
}
