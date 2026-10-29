import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import { buildIndex, search } from "../lib/retrieval/index.ts";
import { applyIntentSlots, detectSourceIntents } from "../lib/retrieval/sourceIntent.ts";

function chunk(id: string, contentType: string | undefined, collection: string, date: string, text: string, scope: "global" | "regional" = "global"): Chunk {
  return {
    id: `${id}::s0`,
    documentId: id,
    documentTitle: id,
    heading: null,
    text,
    citationUrl: null,
    citationUrlType: null,
    regions: scope === "global" ? ["Global"] : ["Brazil"],
    regionScope: scope,
    documentDate: date,
    governance: contentType ? { status: "registered", contentType, collection } : { status: "unregistered" },
  };
}

describe("intent cue", () => {
  it("reads process and recency wording, and nothing for plain knowledge questions", () => {
    assert.deepEqual(detectSourceIntents("How do I onboard a client?"), ["process"]);
    assert.deepEqual(detectSourceIntents("What are the steps of the renewal process?"), ["process"]);
    assert.deepEqual(detectSourceIntents("What's new this week?"), ["recency"]);
    assert.deepEqual(detectSourceIntents("What changed in the renewal process?"), ["process", "recency"]);
    assert.deepEqual(detectSourceIntents("What is Per Subscriber pricing?"), []);
    assert.deepEqual(detectSourceIntents("Write me an elevator pitch."), []);
  });
});

describe("intent slots", () => {
  // Three newsletters announce the renewals training with strong wording; the training holds the steps with weaker wording.
  const announce = (n: number) => chunk(`news${n}`, "Newsletter", "Trending This Week", `Jul ${n}, 2026`, "renewal process training renewal process course announcement renewal process enroll");
  const training = chunk("train", "Training", "Client Success Processes", "Feb 9, 2026", "renewal process step open the opportunity then send the quote");
  const index = buildIndex([announce(1), announce(2), announce(3), training, chunk("other", "Training", "Contracts", "Mar 1, 2026", "contract template")]);
  const query = "How do I run the renewal process?";

  it("adds the process source when the answer set holds only announcements, without touching the existing results", () => {
    const top = search(index, query, 3).filter((r) => r.chunk.documentId.startsWith("news"));
    assert.equal(top.length, 3);
    const r = applyIntentSlots(index, query, query, top, top.map(() => "global" as const), [], top[0].score);
    assert.deepEqual(r.eligible.slice(0, 3).map((x) => x.chunk.id), top.map((x) => x.chunk.id));
    assert.deepEqual(r.info.added.map((a) => [a.intent, a.documentId]), [["process", "train"]]);
    assert.equal(r.eligible.length, 4);
  });
  it("does nothing when a process source is already there, when there is no cue, or when nothing close enough exists", () => {
    const withTraining = search(index, query, 5);
    assert.equal(applyIntentSlots(index, query, query, withTraining, withTraining.map(() => "global" as const), [], withTraining[0].score).info.added.length, 0);
    const news = search(index, "renewal process", 3).filter((r) => r.chunk.documentId.startsWith("news"));
    assert.equal(applyIntentSlots(index, "renewal process", "tell me about renewals", news, news.map(() => "global" as const), [], news[0].score).info.added.length, 0);
    assert.equal(applyIntentSlots(index, "contract template how do I", "How do I", news, news.map(() => "global" as const), [], 1000).info.added.length, 0);
  });
  it("adds the newest update source for a recency question that has none, never an unregistered or out-of-region one", () => {
    const idx = buildIndex([
      chunk("t", "Training", "Pricing", "Mar 1, 2026", "pricing change rules pricing rules"),
      chunk("n1", "Newsletter", "Trending This Week", "Jun 1, 2026", "pricing change rules"),
      chunk("n2", "Newsletter", "Trending This Week", "Jul 20, 2026", "pricing change rules"),
      chunk("nbr", "Newsletter", "Trending This Week", "Aug 1, 2026", "pricing change rules", "regional"),
      chunk("u", undefined, "", "", "pricing change rules"),
    ]);
    const q = "What changed in pricing?";
    const base = search(idx, q, 1);
    const r = applyIntentSlots(idx, q, q, base, ["global"], [], base[0].score);
    assert.deepEqual(r.info.added.map((a) => [a.intent, a.documentId]), [["recency", "n2"]]);
  });
});
