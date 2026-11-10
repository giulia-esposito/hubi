/**
 * Pilot monitoring numbers, built from Cloud Logging (no keys: Application Default Credentials).
 *
 *   node --experimental-strip-types scripts/pilot-metrics.ts [--days 14] [--project wh-revenue-sandbox] [--service hubi-pilot]
 *
 * Writes evals-out/monitoring/metrics-latest.json (git-ignored: it holds question and answer text). The file is a set of
 * tables, one per tab of the "Hubi pilot monitoring" Sheet, as rows of plain values. The daily check writes them to the Sheet.
 * The Apps Script page (monitoring/apps-script) reads the Sheet. The health rules are in lib/monitoring/health.ts.
 *
 * People are not counted: the logs do not hold who asked (HUBI_LOG_ACTOR is off on purpose). Conversations are counted
 * instead: one per page session.
 */
import fs from "node:fs";
import path from "node:path";
import { RATING_LABELS, rateHealth, type WindowStats } from "../lib/monitoring/health.ts";

interface LogEntry {
  timestamp: string;
  jsonPayload?: Record<string, any>;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg("days", "14"));
const project = arg("project", "wh-revenue-sandbox");
const service = arg("service", "hubi-pilot");
const HEALTH_DAYS = 7;
/** First day of real pilot use (a team member first got access on 2026-11-05). Earlier entries are tests and are left out. */
const PILOT_START = arg("since", "2026-11-05");

/** Tags that say the answer was wrong, as opposed to slow, forgetful or "other". */
const INCORRECT_TAGS = new Set(["wrong-region", "unsupported-claim", "scope-or-causality", "wrong-or-missing-source"]);

async function readEntries(): Promise<LogEntry[]> {
  const { GoogleAuth } = await import("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/logging.read"] }).getClient();
  const windowStart = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const since = windowStart > PILOT_START ? windowStart : `${PILOT_START}T00:00:00Z`;
  const filter =
    `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND jsonPayload.component="hubi" ` +
    `AND jsonPayload.type=("interaction" OR "feedback" OR "interaction_error") AND timestamp>="${since}"`;
  const out: LogEntry[] = [];
  let pageToken: string | undefined;
  do {
    const res = await client.request<{ entries?: LogEntry[]; nextPageToken?: string }>({
      url: "https://logging.googleapis.com/v2/entries:list",
      method: "POST",
      data: { resourceNames: [`projects/${project}`], filter, orderBy: "timestamp asc", pageSize: 500, pageToken },
    });
    out.push(...(res.data.entries ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const clip = (text: unknown, n: number) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const seconds = (ms: number) => Math.round(ms / 100) / 10;
const day = (iso: string) => iso.slice(0, 10);
const titlesOf = (turn?: Record<string, any>): string[] => [...new Set(((turn?.sources ?? []) as { documentTitle?: string }[]).map((s) => String(s.documentTitle ?? "").replace(/^\[RKC-\d+\]\s*/, "")).filter(Boolean))];
const isNotCovered = (kind: unknown) => String(kind ?? "") === "no-grounded-answer";
const isAnswerTurn = (kind: unknown) => ["grounded-answer", "no-grounded-answer"].includes(String(kind ?? ""));

function statsFor(interactions: Record<string, any>[], errors: Record<string, any>[], feedback: Record<string, any>[]): WindowStats {
  return {
    turns: interactions.length + errors.length,
    answerTurns: interactions.filter((i) => isAnswerTurn(i.turnKind)).length,
    notCovered: interactions.filter((i) => isNotCovered(i.turnKind)).length,
    errors: errors.length,
    p95LatencyMs: percentile(interactions.map((i) => Number(i.latencyMs)).filter(Number.isFinite), 95),
    votes: feedback.length,
    helpful: feedback.filter((f) => f.helpful === true).length,
  };
}

async function main() {
  const entries = await readEntries();
  const all: Record<string, any>[] = entries.map((e) => ({ ...(e.jsonPayload ?? {}), _ts: e.timestamp }));
  const interactions = all.filter((p) => p.type === "interaction");
  const errors = all.filter((p) => p.type === "interaction_error");
  const feedback = all.filter((p) => p.type === "feedback");
  const byId = new Map(interactions.map((i) => [i.interactionId as string, i]));
  const now = new Date();
  const healthSince = new Date(now.getTime() - HEALTH_DAYS * 24 * 3600 * 1000).toISOString();
  const recent = (p: Record<string, any>) => p._ts >= healthSince;

  // Daily table: one row per day with any activity, newest last. Days without traffic are listed so a gap is visible.
  const dates: string[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(now.getTime() - d * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (date >= PILOT_START) dates.push(date);
  }
  const daily = [["Date (UTC)", "Questions", "Conversations", "Answered", "Not covered", "Asked a question back", "Failed", "Median answer time (s)", "Slowest 5% (s)", "Votes", "Helpful", "Not helpful", "Reported as incorrect"]];
  for (const date of dates) {
    const ints = interactions.filter((i) => day(i._ts) === date);
    const errs = errors.filter((e) => day(e._ts) === date);
    const fbs = feedback.filter((f) => day(f._ts) === date);
    const lat = ints.map((i) => Number(i.latencyMs)).filter(Number.isFinite);
    daily.push([
      date,
      ints.length,
      new Set(ints.map((i) => i.sessionId)).size,
      ints.filter((i) => i.turnKind === "grounded-answer").length,
      ints.filter((i) => isNotCovered(i.turnKind)).length,
      ints.filter((i) => i.turnKind === "clarifying-question").length,
      errs.length,
      ints.length ? seconds(percentile(lat, 50)) : "",
      ints.length ? seconds(percentile(lat, 95)) : "",
      fbs.length,
      fbs.filter((f) => f.helpful === true).length,
      fbs.filter((f) => f.helpful === false).length,
      fbs.filter((f) => f.helpful === false && (f.tags ?? []).some((t: string) => INCORRECT_TAGS.has(t))).length,
    ] as any);
  }

  // Health over the last 7 days.
  const rInt = interactions.filter(recent);
  const rErr = errors.filter(recent);
  const rFb = feedback.filter(recent);
  const stats = statsFor(rInt, rErr, rFb);
  const health = rateHealth(stats);
  const lat7 = rInt.map((i) => Number(i.latencyMs)).filter(Number.isFinite);
  const incorrect7 = rFb.filter((f) => f.helpful === false && (f.tags ?? []).some((t: string) => INCORRECT_TAGS.has(t))).length;

  const summary: (string | number)[][] = [
    ["Metric", "Value", "Rating", "Rule"],
    ["Pilot health (last 7 days)", RATING_LABELS[health.overall], health.overall, "The worst of the four ratings below"],
    ...health.items.map((i) => [i.label, i.value, i.rating, i.rule]),
    ["Questions asked", rInt.length, "", `Last ${HEALTH_DAYS} days`],
    ["Conversations", new Set(rInt.map((i) => i.sessionId)).size, "", "One per page session. People are not counted: Hubi does not record who asks"],
    ["Helpful votes", rFb.filter((f) => f.helpful === true).length, "", ""],
    ["Not helpful votes", rFb.filter((f) => f.helpful === false).length, "", ""],
    ["Reported as incorrect", incorrect7, "", "Not helpful votes tagged wrong region, claim not in the sources, claim overstated, or wrong or missing source"],
    ["Median answer time (s)", seconds(percentile(lat7, 50)), "", ""],
    ["Why not green", health.reasons.join(" ") || "Nothing to flag.", "", ""],
    ["Updated (UTC)", now.toISOString().slice(0, 16).replace("T", " "), "", ""],
  ];

  const feedbackRows: (string | number)[][] = [["Time (UTC)", "Vote", "Reported as", "Comment", "Question", "Answer", "Sources", "Revision"]];
  for (const f of [...feedback].reverse()) {
    const turn = byId.get(f.interactionId);
    const tags: string[] = f.tags ?? [];
    feedbackRows.push([
      f._ts.slice(0, 16).replace("T", " "),
      f.helpful === true ? "Helpful" : "Not helpful",
      f.helpful === true ? "" : tags.some((t) => INCORRECT_TAGS.has(t)) ? `Incorrect: ${tags.filter((t) => INCORRECT_TAGS.has(t)).join(", ")}` : tags.join(", ") || "No reason given",
      clip(f.comment, 400),
      clip(turn?.question, 400),
      clip(turn?.response, 700),
      titlesOf(turn).join("; "),
      String(f.revision ?? ""),
    ]);
  }

  const notCovered: (string | number)[][] = [["Time (UTC)", "Question"]];
  for (const i of [...interactions].reverse()) if (isNotCovered(i.turnKind)) notCovered.push([i._ts.slice(0, 16).replace("T", " "), clip(i.question, 300)]);

  const counts = new Map<string, number>();
  for (const i of interactions) for (const t of titlesOf(i)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const sources: (string | number)[][] = [["Document", "Answers that used it"], ...[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)];

  const dir = path.join("evals-out", "monitoring");
  fs.mkdirSync(dir, { recursive: true });
  const out = { generatedAt: now.toISOString(), days, healthDays: HEALTH_DAYS, health: { overall: health.overall, reasons: health.reasons }, tables: { Summary: summary, Daily: daily, Feedback: feedbackRows, "Not covered": notCovered, Sources: sources } };
  fs.writeFileSync(path.join(dir, "metrics-latest.json"), JSON.stringify(out, null, 2));
  console.log(`Pilot health (last ${HEALTH_DAYS} days): ${RATING_LABELS[health.overall]}`);
  for (const r of health.reasons) console.log(`  - ${r}`);
  console.log(`Questions ${rInt.length}, votes ${rFb.length}, not covered ${notCovered.length - 1} (all ${days} days), failed ${rErr.length}`);
  console.log(`Wrote ${path.join(dir, "metrics-latest.json")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
