/**
 * Pilot feedback and usage report, built from Cloud Logging (no keys: Application Default Credentials).
 *
 *   node --experimental-strip-types scripts/feedback-report.ts [--days 7] [--project wh-revenue-sandbox] [--service hubi-pilot]
 *
 * Writes to evals-out/feedback/ (git-ignored: it contains scrubbed question and answer text):
 *   - feedback-report-<date>.md     the weekly report
 *   - feedback-rows-<date>.json     one row per piece of feedback, for the review Sheet
 *   - gaps-<date>.json              questions Hubi could not answer from the knowledge base, for Content
 *
 * Feedback is joined to its turn by interactionId, so each row carries the question, the answer and the sources.
 * The tester's identity is not in the logs unless HUBI_LOG_ACTOR=1, and this report never prints it.
 */
import fs from "node:fs";
import path from "node:path";

interface LogEntry {
  timestamp: string;
  jsonPayload?: Record<string, any>;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg("days", "7"));
const project = arg("project", "wh-revenue-sandbox");
const service = arg("service", "hubi-pilot");

async function readEntries(): Promise<LogEntry[]> {
  const { GoogleAuth } = await import("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/logging.read"] }).getClient();
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
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

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function clip(text: unknown, n: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function count<T>(items: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function titlesOf(interaction: Record<string, any> | undefined): string[] {
  const sources = (interaction?.sources ?? []) as { documentTitle?: string }[];
  return [...new Set(sources.map((s) => s.documentTitle ?? "").filter(Boolean))];
}

async function main() {
  const entries = await readEntries();
  const payloads: Record<string, any>[] = entries.map((e) => ({ ...(e.jsonPayload ?? {}), _ts: e.timestamp }));
  const interactions = payloads.filter((p) => p.type === "interaction");
  const errors = payloads.filter((p) => p.type === "interaction_error");
  const feedback = payloads.filter((p) => p.type === "feedback");
  const byId = new Map(interactions.map((i) => [i.interactionId as string, i]));

  const sessions = new Set(interactions.map((i) => i.sessionId));
  const latencies = interactions.map((i) => Number(i.latencyMs)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const turnKinds = count(interactions, (i) => String(i.turnKind ?? "unknown"));
  const helpful = feedback.filter((f) => f.helpful === true).length;
  const unhelpful = feedback.filter((f) => f.helpful === false).length;
  const tagCounts = count(feedback.flatMap((f) => (f.tags ?? []).map((t: string) => ({ t }))), (x) => x.t);
  const sourceCounts = count(interactions.flatMap((i) => titlesOf(i).map((t) => ({ t }))), (x) => x.t);

  // Questions the knowledge base could not answer: the gap list for Content.
  const gaps = interactions.filter((i) => /no-grounded|no-retriev|refus|not-found|unanswer/i.test(String(i.turnKind ?? "")));

  const rows = feedback.map((f) => {
    const turn = byId.get(f.interactionId);
    return {
      interactionId: f.interactionId,
      timestamp: f._ts,
      helpful: f.helpful === true ? "yes" : "no",
      tags: (f.tags ?? []).join(", "),
      comment: f.comment ?? "",
      waitSeconds: typeof f.waitMs === "number" ? Math.round(f.waitMs / 100) / 10 : "",
      question: clip(turn?.question, 500),
      answer: clip(turn?.response, 800),
      turnKind: turn?.turnKind ?? "",
      sources: titlesOf(turn).join("; "),
      revision: f.revision ?? "",
    };
  });

  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join("evals-out", "feedback");
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  lines.push(`# Hubi pilot report: last ${days} days (to ${date})`);
  lines.push("");
  lines.push("## Volume and health");
  lines.push(`- Questions answered: **${interactions.length}** in **${sessions.size}** conversations`);
  lines.push(`- Failed turns: **${errors.length}**${errors.length ? ` (${count(errors, (e) => clip(e.error, 80)).slice(0, 3).map(([k, n]) => `${n}× ${k}`).join("; ")})` : ""}`);
  lines.push(`- Time to full answer: median **${(pct(latencies, 50) / 1000).toFixed(1)} s**, p95 **${(pct(latencies, 95) / 1000).toFixed(1)} s**`);
  lines.push(`- Feedback: **${feedback.length}** (${helpful} helpful, ${unhelpful} not helpful); feedback rate ${interactions.length ? Math.round((feedback.length / interactions.length) * 100) : 0}% of answers`);
  lines.push(`- Turn types: ${turnKinds.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  lines.push("");
  lines.push("## Not helpful, with the question and the answer");
  const bad = rows.filter((r) => r.helpful === "no");
  if (bad.length === 0) lines.push("None this period.");
  for (const r of bad) {
    lines.push(`- **${r.timestamp.slice(0, 16).replace("T", " ")}** · tags: ${r.tags || "none"}${r.comment ? ` · comment: "${clip(r.comment, 300)}"` : ""}`);
    lines.push(`  - Question: ${r.question}`);
    lines.push(`  - Answer: ${clip(r.answer, 300)}`);
    lines.push(`  - Sources: ${r.sources || "none"}${r.waitSeconds !== "" ? ` · waited ${r.waitSeconds} s` : ""}`);
  }
  lines.push("");
  lines.push("## What testers flagged");
  lines.push(tagCounts.length ? tagCounts.map(([t, n]) => `- ${t}: ${n}`).join("\n") : "No tags yet.");
  lines.push("");
  lines.push("## Questions Hubi could not answer (content gaps for Content)");
  lines.push(gaps.length ? gaps.map((g) => `- ${clip(g.question, 200)}`).join("\n") : "None detected.");
  lines.push("");
  lines.push("## Most used source documents");
  lines.push(sourceCounts.length ? sourceCounts.slice(0, 10).map(([t, n]) => `- ${t}: ${n} answers`).join("\n") : "No sources recorded.");
  lines.push("");

  fs.writeFileSync(path.join(dir, `feedback-report-${date}.md`), lines.join("\n"));
  fs.writeFileSync(path.join(dir, `feedback-rows-${date}.json`), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(dir, `gaps-${date}.json`), JSON.stringify(gaps.map((g) => ({ question: g.question, turnKind: g.turnKind, timestamp: g._ts })), null, 2));
  console.log(lines.join("\n"));
  console.log(`\nWrote ${dir}${path.sep}feedback-report-${date}.md, feedback-rows-${date}.json, gaps-${date}.json`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
