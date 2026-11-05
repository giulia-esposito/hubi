/**
 * Load test for the chat route (audit item P1-10). Sends a mix of questions at a fixed concurrency and reports the
 * outcome counts and the latency distribution (time to first event, time to first answer text, time to done).
 * Calls a live model when the target runs the Gemini provider: it costs money, so start small.
 *
 *   node --experimental-strip-types scripts/load-test.ts --url http://127.0.0.1:3100 --concurrency 10 --requests 40
 *
 * Options:
 *   --url <base>          target server (default http://127.0.0.1:3000)
 *   --concurrency <n>     requests in flight at once (default 5)
 *   --requests <n>        total requests (default 20)
 *   --users <n>           distinct simulated callers, sent as x-goog-authenticated-user-email (default = concurrency)
 *   --header "K: V"       extra header, repeatable (for example an identity token for a service behind IAP)
 *   --out <file>          also write the JSON summary to this file
 *
 * What it can and cannot tell: it measures this server plus the model behind it under the stated concurrency. Run
 * against a local `next start` it says nothing about Cloud Run networking or cold starts. Questions are single-turn,
 * so the buffered verify-and-revise path (artifact follow-ups) is not exercised.
 */
import { writeFileSync } from "node:fs";

const QUESTIONS = [
  "How long does Salesforce access take?",
  "What is the onboarding process for a new client?",
  "How do I create an opportunity in Salesforce?",
  "What is Wellhub?",
  "How do I use Gong to review calls?",
  "Quais ferramentas de vendas eu posso acessar?",
  "How should I handle competition in a client conversation?",
  "What is the discount policy?",
  "Which meetings do I run in the first 30 days of onboarding?",
  "How do I report a problem with access to a sales tool?",
];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === `--${name}` && out.push(process.argv[i + 1]));
  return out;
}

const base = (arg("url", "http://127.0.0.1:3000") as string).replace(/\/$/, "");
const concurrency = Math.max(1, Number(arg("concurrency", "5")));
const total = Math.max(1, Number(arg("requests", "20")));
const users = Math.max(1, Number(arg("users", String(concurrency))));
const extraHeaders = Object.fromEntries(args("header").map((h) => [h.slice(0, h.indexOf(":")).trim(), h.slice(h.indexOf(":") + 1).trim()]));

interface Sample {
  outcome: string;
  firstEventMs: number | null;
  firstTextMs: number | null;
  totalMs: number;
}

async function one(n: number): Promise<Sample> {
  const started = performance.now();
  const question = QUESTIONS[n % QUESTIONS.length];
  let firstEventMs: number | null = null;
  let firstTextMs: number | null = null;
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-authenticated-user-email": `load-user-${n % users}@example.com`, ...extraHeaders },
      body: JSON.stringify({ sessionId: `load-${n}-${Date.now()}`, question }),
    });
    if (res.status !== 200) {
      await res.text().catch(() => "");
      return { outcome: `http ${res.status}`, firstEventMs: null, firstTextMs: null, totalMs: performance.now() - started };
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome = "no-done-event";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as { type: string; ok?: boolean; error?: string; text?: string };
        const t = performance.now() - started;
        if (firstEventMs === null) firstEventMs = t;
        if (ev.type === "delta" && firstTextMs === null && ev.text) firstTextMs = t;
        if (ev.type === "done") outcome = ev.ok ? "ok" : `error: ${String(ev.error).slice(0, 60)}`;
      }
    }
    return { outcome, firstEventMs, firstTextMs, totalMs: performance.now() - started };
  } catch (err) {
    return { outcome: `exception: ${String((err as Error).message ?? err).slice(0, 60)}`, firstEventMs, firstTextMs, totalMs: performance.now() - started };
  }
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

async function main() {
  console.log(`Load test: ${total} requests, concurrency ${concurrency}, ${users} callers, target ${base}`);
  const samples: Sample[] = [];
  let next = 0;
  const wall = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) samples.push(await one(next++));
    })
  );
  const wallMs = performance.now() - wall;
  const outcomes: Record<string, number> = {};
  for (const s of samples) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
  const okTimes = samples.filter((s) => s.outcome === "ok");
  const summary = {
    target: base,
    concurrency,
    requests: total,
    wallSeconds: Math.round(wallMs / 100) / 10,
    throughputPerMin: Math.round((total / wallMs) * 60000 * 10) / 10,
    outcomes,
    okRate: Math.round((okTimes.length / total) * 1000) / 10,
    firstEventMs: { p50: pct(okTimes.map((s) => s.firstEventMs ?? 0), 50), p95: pct(okTimes.map((s) => s.firstEventMs ?? 0), 95) },
    firstTextMs: { p50: pct(okTimes.flatMap((s) => (s.firstTextMs === null ? [] : [s.firstTextMs])), 50), p95: pct(okTimes.flatMap((s) => (s.firstTextMs === null ? [] : [s.firstTextMs])), 95) },
    totalMs: { p50: pct(okTimes.map((s) => s.totalMs), 50), p95: pct(okTimes.map((s) => s.totalMs), 95), max: pct(okTimes.map((s) => s.totalMs), 100) },
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
}

main();
