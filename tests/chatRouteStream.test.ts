import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { setKnowledgeBaseForTests } from "../lib/runtime/knowledgeBase.ts";
import { setReasoningEngineForTests, type ReasoningEngine, type ReasoningOptions } from "../lib/runtime/reasoningEngine.ts";

// End to end through the real route, offline: a request goes in, the real governance gate, retrieval, applicability
// layer and prompt builder run on a small in-memory corpus, and a fake model answers. What is asserted is the
// contract the web client depends on: the NDJSON event sequence, tags kept off the screen, sources that match the
// answer, content that governance excluded never reaching the user or the model, and failures reported as events.

const chunk = (id: string, title: string, heading: string, text: string): Chunk => ({
  id: `${id}::s0`,
  documentId: id,
  documentTitle: title,
  heading,
  text,
  citationUrl: `https://example.com/${encodeURIComponent(id)}`,
  citationUrlType: "sourceUrl",
  regions: ["Global"],
  regionScope: "global",
  regionRaw: "Global",
});

const CHUNKS: Chunk[] = [
  chunk("Sales Tools Access", "Sales Tools Access Guide", "Salesforce access", "Salesforce access is requested through the Access Request form. Access is usually granted within 7 days after the manager approves the request."),
  // RKC-000021 is Not Eligible in the registry snapshot: governance must remove it before retrieval.
  chunk("RKC-000021", "Excluded Elevator Pitch", "Pitch", "Salesforce access secret pitch text that must never be shown to the user or to the model."),
];

type Event = Record<string, unknown> & { type: string };

async function ask(route: { POST: (r: Request) => Promise<Response> }, question: string, caller = "tester@example.com"): Promise<{ status: number; events: Event[]; contentType: string }> {
  const res = await route.POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-authenticated-user-email": caller },
      body: JSON.stringify({ sessionId: crypto.randomUUID(), question }),
    })
  );
  const body = await res.text();
  const events = body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
  return { status: res.status, events, contentType: res.headers.get("Content-Type") ?? "" };
}

describe("POST /api/chat, streamed turn (offline, fake model)", () => {
  let route: { POST: (r: Request) => Promise<Response> };
  const calls: { prompt: string; fast: boolean; signalled: boolean }[] = [];
  let behavior: (prompt: string, opts: ReasoningOptions) => { ok: boolean; text: string; error?: string } = () => ({ ok: true, text: "" });

  const engine: ReasoningEngine = async (prompt, _system, opts = {}) => {
    calls.push({ prompt, fast: Boolean(opts.fast), signalled: Boolean(opts.signal) });
    // Helper calls (query expansion, scope judge) degrade, as the pipeline is built to allow.
    if (opts.fast) return { ok: false, text: "", mode: "stream", durationMs: 1, error: "not available in this test" };
    const r = behavior(prompt, opts);
    // Streamed in small pieces, so tags can be split across deltas as a real model's output can be.
    if (r.ok) for (let i = 0; i < r.text.length; i += 25) opts.onDelta?.(r.text.slice(i, i + 25));
    return { ok: r.ok, text: r.ok ? r.text : "", mode: "stream", durationMs: 5, error: r.error };
  };

  before(async () => {
    process.env.HUBI_LOG_FILE = "0";
    process.env.HUBI_LOG_STDOUT = "0";
    process.env.HUBI_RATE_LIMIT_PER_MIN = "0";
    process.env.HUBI_VERIFY_CLAIMS = "0";
    const { index, excluded } = buildGovernedIndex(CHUNKS);
    setKnowledgeBaseForTests({ index, documentCount: 2, chunkCount: CHUNKS.length, excluded, governance: { registry: { source: "t", sourceRevision: "1", syncedAt: "2026-11-05", entries: 0 }, chunksIn: 2, chunksKept: 1, excluded, restricted: [], unregistered: [], drift: [] } });
    setReasoningEngineForTests(engine);
    route = await import("../app/api/chat/route.ts");
  });

  beforeEach(() => {
    calls.length = 0;
  });

  test("a grounded question streams retrieval, then answer text without tags, then a done event", async () => {
    behavior = () => ({ ok: true, text: "[[HUBI:MODE:KNOWLEDGE_RETRIEVAL]]\nAccess is usually granted within 7 days.\n[[HUBI:GROUNDED_ANSWER]]" });
    const { status, events, contentType } = await ask(route, "How long does Salesforce access take?");
    assert.equal(status, 200);
    assert.match(contentType, /application\/x-ndjson/);
    assert.equal(events[0].type, "retrieval");
    assert.equal(events[events.length - 1].type, "done");
    const shown = events.filter((e) => e.type === "delta").map((e) => String(e.text)).join("");
    assert.match(shown, /7 days/);
    assert.ok(!shown.includes("[[HUBI"), "response tags must never reach the screen");
    const done = events[events.length - 1];
    assert.equal(done.ok, true);
    assert.equal(done.turnKind, "grounded-answer");
    assert.equal(done.planningMode, "knowledge-retrieval");
    assert.ok(typeof done.interactionId === "string");
  });

  test("the sources sent to the client are the ones the model saw, and the model call can be cancelled", async () => {
    behavior = () => ({ ok: true, text: "[[HUBI:MODE:KNOWLEDGE_RETRIEVAL]]\nOk.\n[[HUBI:GROUNDED_ANSWER]]" });
    const { events } = await ask(route, "How long does Salesforce access take?");
    const retrieval = events[0] as unknown as { sources: { documentTitle: string; citationUrl: string | null }[]; chunkCount: number };
    assert.equal(retrieval.chunkCount, 1);
    assert.equal(retrieval.sources[0].documentTitle, "Sales Tools Access Guide");
    assert.ok(retrieval.sources[0].citationUrl?.startsWith("https://example.com/"));
    const answerCall = calls.find((c) => !c.fast);
    assert.ok(answerCall, "the model was called for the answer");
    assert.equal(answerCall.signalled, true, "the request's abort signal reaches the model call");
  });

  test("content removed by the governance gate never reaches the model or the user", async () => {
    behavior = () => ({ ok: true, text: "[[HUBI:MODE:KNOWLEDGE_RETRIEVAL]]\nOk.\n[[HUBI:GROUNDED_ANSWER]]" });
    const { events } = await ask(route, "Tell me about the Salesforce access secret pitch");
    const everything = JSON.stringify(events) + calls.map((c) => c.prompt).join("\n");
    assert.ok(!everything.includes("secret pitch text"), "excluded text leaked");
    assert.ok(!everything.includes("RKC-000021"), "excluded document id leaked");
  });

  test("a question with nothing retrieved is refused deterministically, without calling the model for an answer", async () => {
    behavior = () => ({ ok: true, text: "should not be used" });
    const { events } = await ask(route, "zzzqx plugh xyzzy");
    const done = events[events.length - 1];
    assert.equal(done.type, "done");
    const shown = events.filter((e) => e.type === "delta").map((e) => String(e.text)).join("");
    assert.match(shown, /grounded information/i);
    assert.equal(calls.filter((c) => !c.fast).length, 0);
  });

  test("a model failure ends the stream with a done event that says so, not a broken response", async () => {
    behavior = () => ({ ok: false, text: "", error: "UNAVAILABLE upstream" });
    const { status, events } = await ask(route, "How long does Salesforce access take?");
    assert.equal(status, 200);
    const done = events[events.length - 1];
    assert.equal(done.type, "done");
    assert.equal(done.ok, false);
    assert.ok(typeof done.error === "string" && done.error.length > 0);
  });
});
