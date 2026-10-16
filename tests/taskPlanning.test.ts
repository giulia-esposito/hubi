import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractResponseTags, extractTurnKind, createTagAwareStreamer } from "../lib/runtime/turnKind.ts";
import { HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { PLANNING_MODES } from "../lib/runtime/planningMode.ts";

// Offline and deterministic, like the rest of tests/*.test.ts: nothing here
// calls a live model. What the model actually *writes* for each planning mode
// is covered by scripts/eval-task-planning.ts, which needs a live provider.

const BODY = "Here is a short answer.\n\nWith a second paragraph that is long enough to stream in several pieces.";

function wrap(mode: string, kind: string, body = BODY): string {
  return `[[HUBI:MODE:${mode}]]\n${body}\n[[HUBI:${kind}]]`;
}

describe("extractResponseTags", () => {
  test("parses every planning mode alongside turn kind, as independent dimensions", () => {
    const cases = [
      ["KNOWLEDGE_RETRIEVAL", "knowledge-retrieval"],
      ["KNOWLEDGE_SYNTHESIS", "knowledge-synthesis"],
      ["BUSINESS_ASSISTANCE", "business-assistance"],
    ] as const;
    for (const [keyword, mode] of cases) {
      const r = extractResponseTags(wrap(keyword, "GROUNDED_ANSWER"));
      assert.equal(r.planningMode, mode);
      assert.equal(r.turnKind, "grounded-answer");
      assert.equal(r.text, BODY);
    }
    assert.deepEqual([...PLANNING_MODES], ["knowledge-retrieval", "knowledge-synthesis", "business-assistance"]);
  });

  test("a business-assistance artifact can still carry any turn kind", () => {
    assert.equal(extractResponseTags(wrap("BUSINESS_ASSISTANCE", "CLARIFYING_QUESTION")).turnKind, "clarifying-question");
    assert.equal(extractResponseTags(wrap("BUSINESS_ASSISTANCE", "NO_GROUNDED_ANSWER")).turnKind, "no-grounded-answer");
  });

  test("missing mode tag -> unknown mode, text and turn kind preserved", () => {
    const r = extractResponseTags(`${BODY}\n[[HUBI:GROUNDED_ANSWER]]`);
    assert.equal(r.planningMode, "unknown");
    assert.equal(r.turnKind, "grounded-answer");
    assert.equal(r.text, BODY);
  });

  test("missing turn-kind tag -> unknown turn kind, mode preserved", () => {
    const r = extractResponseTags(`[[HUBI:MODE:KNOWLEDGE_SYNTHESIS]]\n${BODY}`);
    assert.equal(r.planningMode, "knowledge-synthesis");
    assert.equal(r.turnKind, "unknown");
    assert.equal(r.text, BODY);
  });

  test("no tags at all -> both unknown, text untouched", () => {
    const r = extractResponseTags(BODY);
    assert.equal(r.planningMode, "unknown");
    assert.equal(r.turnKind, "unknown");
    assert.equal(r.text, BODY);
  });

  test("malformed mode keyword is stripped from the text and reported as unknown", () => {
    const r = extractResponseTags(wrap("BUSINESS_ASSISTANCEE", "GROUNDED_ANSWER"));
    assert.equal(r.planningMode, "unknown");
    assert.equal(r.text, BODY);
  });

  test("a mode-like string in the middle of the body is not treated as a tag", () => {
    const body = "Use [[HUBI:MODE:BUSINESS_ASSISTANCE]] only as an example.";
    const r = extractResponseTags(`[[HUBI:MODE:KNOWLEDGE_RETRIEVAL]]\n${body}\n[[HUBI:GROUNDED_ANSWER]]`);
    assert.equal(r.planningMode, "knowledge-retrieval");
    assert.equal(r.text, body);
  });

  test("extractTurnKind remains backward compatible and also strips the mode tag", () => {
    const r = extractTurnKind(wrap("BUSINESS_ASSISTANCE", "GROUNDED_ANSWER"));
    assert.deepEqual(r, { text: BODY, turnKind: "grounded-answer" });
  });
});

function streamInChunks(raw: string, chunkSizes: number[]): string {
  const out: string[] = [];
  const streamer = createTagAwareStreamer((t) => out.push(t));
  let i = 0;
  let k = 0;
  while (i < raw.length) {
    const size = chunkSizes[k++ % chunkSizes.length];
    streamer.push(raw.slice(i, i + size));
    i += size;
  }
  streamer.finish();
  return out.join("");
}

describe("createTagAwareStreamer", () => {
  const raw = wrap("BUSINESS_ASSISTANCE", "GROUNDED_ANSWER", `${BODY} `.repeat(6).trim());
  const expected = `${BODY} `.repeat(6).trim();

  test("never leaks either tag, for any chunk size", () => {
    for (const size of [1, 2, 3, 5, 7, 13, 40, 1000]) {
      const visible = streamInChunks(raw, [size]);
      assert.equal(visible.trim(), expected, `chunk size ${size}`);
      assert.ok(!visible.includes("[[HUBI"), `chunk size ${size} leaked a tag`);
    }
  });

  test("never leaks when the tag boundary falls at every possible split point", () => {
    for (let split = 1; split < raw.length; split++) {
      const out: string[] = [];
      const streamer = createTagAwareStreamer((t) => out.push(t));
      streamer.push(raw.slice(0, split));
      streamer.push(raw.slice(split));
      streamer.finish();
      const visible = out.join("");
      assert.ok(!visible.includes("[[HUBI"), `split ${split} leaked a tag`);
      assert.equal(visible.trim(), expected, `split ${split}`);
    }
  });

  test("short responses (shorter than the holdback) are still delivered intact", () => {
    const visible = streamInChunks(wrap("KNOWLEDGE_RETRIEVAL", "GROUNDED_ANSWER", "Yes."), [4]);
    assert.equal(visible.trim(), "Yes.");
  });

  test("a response with no mode tag streams through unchanged", () => {
    const visible = streamInChunks(`${expected}\n[[HUBI:GROUNDED_ANSWER]]`, [6]);
    assert.equal(visible.trim(), expected);
  });

  test("a malformed mode tag is held, then dropped without leaking", () => {
    const visible = streamInChunks(wrap("BUSINESS_ASSISTANCEE", "GROUNDED_ANSWER", expected), [3]);
    assert.ok(!visible.includes("[[HUBI"));
    assert.equal(visible.trim(), expected);
  });
});

describe("HUBI_SYSTEM_PROMPT contract", () => {
  test("defines all three planning modes and the leading-tag format", () => {
    for (const keyword of ["KNOWLEDGE_RETRIEVAL", "KNOWLEDGE_SYNTHESIS", "BUSINESS_ASSISTANCE"]) {
      assert.ok(HUBI_SYSTEM_PROMPT.includes(`[[HUBI:MODE:${keyword}]]`), keyword);
    }
    assert.match(HUBI_SYSTEM_PROMPT, /VERY FIRST line/);
  });

  test("keeps the turn-kind tags, including the artifact-with-omission case", () => {
    for (const tag of ["GROUNDED_ANSWER", "CLARIFYING_QUESTION", "NO_GROUNDED_ANSWER"]) {
      assert.ok(HUBI_SYSTEM_PROMPT.includes(`[[HUBI:${tag}]]`), tag);
    }
    assert.match(HUBI_SYSTEM_PROMPT, /even if you had to omit or qualify some unsupported detail/);
  });

  test("states that retrieval applies to every mode and sources serve fact and craft roles", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /supplied for every request/);
    assert.match(HUBI_SYSTEM_PROMPT, /FACT source/);
    assert.match(HUBI_SYSTEM_PROMPT, /CRAFT reference/);
  });

  test("a missing ready-made artifact is never a reason to refuse; a missing detail never voids the artifact", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /NEVER a reason to refuse/);
    assert.match(HUBI_SYSTEM_PROMPT, /do NOT refuse the artifact/);
  });

  test("keeps the claim-level grounding boundary and the governance rules", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /Every Wellhub-specific factual claim must be traceable/);
    assert.match(HUBI_SYSTEM_PROMPT, /Never invent a number/);
    assert.match(HUBI_SYSTEM_PROMPT, /changes WHICH FACTS APPLY/);
  });

  test("no longer forbids generic sales craft", () => {
    assert.ok(!/outside knowledge about Wellhub, competitors, or sales processes/.test(HUBI_SYSTEM_PROMPT));
  });

  test("is general: no hard-coded phrases from specific test requests", () => {
    // Generic artifact categories ("write a pitch", "draft an email") are
    // allowed as mode examples; the specific regression requests are not.
    for (const phrase of ["elevator pitch", "1-min", "one-minute", "financial", "burnout"]) {
      assert.ok(!HUBI_SYSTEM_PROMPT.toLowerCase().includes(phrase), `prompt must not special-case "${phrase}"`);
    }
  });
});

describe("extractResponseTags: tolerance for live model drift", () => {
  test("a leading mode keyword without MODE: is accepted and stripped (seen live on Gemini)", () => {
    const r = extractResponseTags(`[[HUBI:BUSINESS_ASSISTANCE]]\n${BODY}\n[[HUBI:GROUNDED_ANSWER]]`);
    assert.equal(r.planningMode, "business-assistance");
    assert.equal(r.turnKind, "grounded-answer");
    assert.equal(r.text, BODY);
  });

  test("a turn-kind tag on line 1 is stripped; it supplies the turn kind only when no trailing tag exists", () => {
    const onlyLeading = extractResponseTags(`[[HUBI:NO_GROUNDED_ANSWER]]\n${BODY}`);
    assert.equal(onlyLeading.planningMode, "unknown");
    assert.equal(onlyLeading.turnKind, "no-grounded-answer");
    assert.equal(onlyLeading.text, BODY);

    const both = extractResponseTags(`[[HUBI:NO_GROUNDED_ANSWER]]\n${BODY}\n[[HUBI:GROUNDED_ANSWER]]`);
    assert.equal(both.turnKind, "grounded-answer");
    assert.equal(both.text, BODY);
  });

  test("an unrecognized leading tag is stripped and both fields stay unknown", () => {
    const r = extractResponseTags(`[[HUBI:SOMETHING_ELSE]]\n${BODY}`);
    assert.equal(r.planningMode, "unknown");
    assert.equal(r.turnKind, "unknown");
    assert.equal(r.text, BODY);
  });
});

describe("createTagAwareStreamer: drift and whitespace", () => {
  const body = "Wellhub can transform wellbeing for your team and keep the whole company engaged every day.";

  function collect(raw: string, splitAt: number): string {
    const out: string[] = [];
    const streamer = createTagAwareStreamer((t) => out.push(t));
    streamer.push(raw.slice(0, splitAt));
    streamer.push(raw.slice(splitAt));
    streamer.finish();
    return out.join("");
  }

  test("never loses a space where the held-back remainder begins (regression: 'cantransform')", () => {
    // Pad so that, for some length, the holdback boundary lands exactly on a space.
    for (let pad = 0; pad < 70; pad++) {
      const text = `${"a".repeat(pad + 1)} ${body}`;
      const raw = `[[HUBI:MODE:BUSINESS_ASSISTANCE]]\n${text}\n[[HUBI:GROUNDED_ANSWER]]`;
      assert.equal(collect(raw, raw.length), text, `pad ${pad}`);
      assert.equal(collect(raw, 20), text, `pad ${pad}, split`);
    }
  });

  test("never leaks a leading tag that is missing MODE: or is a turn-kind tag", () => {
    for (const first of ["[[HUBI:BUSINESS_ASSISTANCE]]", "[[HUBI:NO_GROUNDED_ANSWER]]", "[[HUBI:MODE:KNOWLEDGE_SYNTHESIS]]"]) {
      const raw = `${first}\n${body}\n[[HUBI:GROUNDED_ANSWER]]`;
      for (let split = 1; split < raw.length; split++) {
        const visible = collect(raw, split);
        assert.ok(!visible.includes("[[HUBI"), `${first} split ${split} leaked`);
        assert.equal(visible, body, `${first} split ${split}`);
      }
    }
  });
});

describe("HUBI_SYSTEM_PROMPT: tag format reinforcement", () => {
  test("states that MODE: is mandatory on line 1 and shows the correct response shape", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /MODE: is mandatory/);
    assert.match(HUBI_SYSTEM_PROMPT, /never contains a turn-kind tag/);
    assert.match(HUBI_SYSTEM_PROMPT, /\[\[HUBI:MODE:BUSINESS_ASSISTANCE\]\]\n<the response>\n\[\[HUBI:GROUNDED_ANSWER\]\]/);
  });
});

describe("control-tag contract on clarifying and refusing turns", () => {
  test("a clarifying turn carries both tags and parses to its mode plus clarifying-question", () => {
    const question = "Which region does this client operate in?";
    for (const mode of ["KNOWLEDGE_RETRIEVAL", "KNOWLEDGE_SYNTHESIS", "BUSINESS_ASSISTANCE"]) {
      const r = extractResponseTags(`[[HUBI:MODE:${mode}]]\n${question}\n[[HUBI:CLARIFYING_QUESTION]]`);
      assert.equal(r.turnKind, "clarifying-question");
      assert.notEqual(r.planningMode, "unknown", mode);
      assert.equal(r.text, question);
    }
  });

  test("a clarifying turn streams without leaking either tag", () => {
    const question = "Which region does this client operate in, and which segment?";
    const raw = `[[HUBI:MODE:BUSINESS_ASSISTANCE]]\n${question}\n[[HUBI:CLARIFYING_QUESTION]]`;
    for (let split = 1; split < raw.length; split++) {
      const out: string[] = [];
      const streamer = createTagAwareStreamer((t) => out.push(t));
      streamer.push(raw.slice(0, split));
      streamer.push(raw.slice(split));
      streamer.finish();
      assert.equal(out.join(""), question, `split ${split}`);
    }
  });

  test("a clarifying turn that skips the line-1 tag is detectable: mode stays unknown, kind is still read", () => {
    const r = extractResponseTags("Which region?\n[[HUBI:CLARIFYING_QUESTION]]");
    assert.equal(r.planningMode, "unknown");
    assert.equal(r.turnKind, "clarifying-question");
  });

  test("the prompt requires both tags on clarifying turns and calls a missing tag malformed", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /even when your whole response is a clarifying question/);
    assert.match(HUBI_SYSTEM_PROMPT, /without the line-1 tag or without the final tag is malformed/);
  });
});

describe("existence and availability questions", () => {
  test("the prompt classifies existence/availability checks as KNOWLEDGE_RETRIEVAL in general terms", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /exists or where it can be found/);
    for (const example of ["Do we have X?", "Is there guidance for X?", "Where can I find X?"]) {
      assert.ok(HUBI_SYSTEM_PROMPT.includes(example), example);
    }
    assert.match(HUBI_SYSTEM_PROMPT, /so it is KNOWLEDGE_RETRIEVAL even when your answer briefly summarizes/);
  });
});

describe("Business Assistance completion and benefit-claim rules", () => {
  test("write the finished artifact when facts are available; ask only when applicability changes", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /write it\. Do not ask the user for a business problem, value proposition, proof point/);
    assert.match(HUBI_SYSTEM_PROMPT, /do not hand back a fill-in-the-blank template/);
    assert.match(HUBI_SYSTEM_PROMPT, /Ask only when the missing context would change which facts apply/);
  });

  test("benefit and outcome claims are facts; tailoring changes tone, not claims; gaps get no example figures", () => {
    assert.match(HUBI_SYSTEM_PROMPT, /Claims about what Wellhub delivers or causes/);
    assert.match(HUBI_SYSTEM_PROMPT, /Do not imply them through framing either/);
    assert.match(HUBI_SYSTEM_PROMPT, /adapt tone, vocabulary, examples of situations and emphasis only/);
    assert.match(HUBI_SYSTEM_PROMPT, /do not suggest example figures, outcomes or benefits to fill it/);
  });
});
