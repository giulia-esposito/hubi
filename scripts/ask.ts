import readline from "node:readline";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import type { RetrievalIndex } from "../lib/retrieval/index.ts";
import { buildGovernedIndex } from "../lib/runtime/governedIndex.ts";
import { retrieveApplicable } from "../lib/runtime/retrieveApplicable.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { formatApplicabilityLabel, formatCitation } from "../lib/runtime/citationBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { generateWithVerification, ledgerEnabled, shouldVerify } from "../lib/runtime/verifiedGeneration.ts";
import { createSession, addTurn, accumulatedUserQuery, type Session } from "../lib/runtime/sessionState.ts";
import { createTagAwareStreamer, extractResponseTags } from "../lib/runtime/turnKind.ts";

const CONTENT_REPO = "Content Repository";

async function handleQuestion(question: string, index: RetrievalIndex, session: Session): Promise<void> {
  const historyBeforeThisTurn = [...session.turns];
  addTurn(session, "user", question);

  // Retrieval uses every user message so far, not just this one -- see
  // lib/runtime/sessionState.ts for why (keeps a clarifying-question
  // exchange retrieving relevant content without a separate classifier).
  const retrievalQuery = accumulatedUserQuery(session);
  const userMessages = session.turns.filter((t) => t.role === "user").map((t) => t.content);
  const { raw, decision, factPass, retrievalMs } = retrieveApplicable(index, retrievalQuery, userMessages, {
    lastPlanningMode: session.lastPlanningMode,
  });
  const results = decision.eligible;

  console.log(`\n[Retrieval] ${raw.length} chunk(s) matched; ${results.length} passed the Applicability Layer.`);
  console.log(
    `[Applicability] mode=${decision.mode} | task region: ${decision.taskRegions.join(", ") || "unknown"}${decision.taskCountries.length ? " (country: " + decision.taskCountries.join(", ") + ")" : ""}` +
      ` | withheld (region unknown): ${decision.withheldCount}${decision.withheldRegions.length ? " [" + decision.withheldRegions.join(", ") + "]" : ""}` +
      ` | excluded (other region): ${decision.mismatchCount}${decision.mismatchRegions.length ? " [" + decision.mismatchRegions.join(", ") + "]" : ""}`
  );
  console.log(
    `[Fact pass] ${factPass.triggered ? "triggered, added " + factPass.added + " chunk(s); query: " + factPass.query : "not run (" + factPass.reason + ")"} | retrieval ${retrievalMs.toFixed(1)} ms`
  );
  results.forEach((r, i) =>
    console.log(
      `  [${i + 1}] score=${r.score.toFixed(2)} ${r.chunk.documentTitle}${r.chunk.heading ? " -> " + r.chunk.heading : ""} (${formatApplicabilityLabel(r.chunk)})`
    )
  );

  // Deterministic refusal only when retrieval itself found nothing; a gated
  // turn still calls the model (with no retrieved content) so the reply is
  // written in the user's language.
  if (raw.length === 0) {
    const refusal =
      "I don't have grounded information on this in the current knowledge base. " +
      "I won't guess -- try rephrasing, or this may be outside what's been ingested so far.";
    console.log(`\nHubi: ${refusal}`);
    addTurn(session, "assistant", refusal);
    return;
  }

  const verify = shouldVerify(question, session.lastPlanningMode);
  const useLedger = verify && ledgerEnabled();
  const prompt = buildPrompt(question, results, historyBeforeThisTurn, decision, { ledger: useLedger });

  process.stdout.write("\nHubi: ");
  const streamer = createTagAwareStreamer((visible) => process.stdout.write(visible));
  // Verify-and-revise (prototype, HUBI_VERIFY_CLAIMS=1): artifact-request turns are buffered and checked.
  const { response, verification } = await generateWithVerification({
    engine: getReasoningEngine(),
    prompt,
    systemPrompt: HUBI_SYSTEM_PROMPT,
    retrievedTexts: results.map((r) => r.chunk.text),
    verify,
    ledger: useLedger,
    onDelta: (t) => streamer.push(t),
  });
  if (verify) {
    if (response.ok) process.stdout.write(extractResponseTags(response.text).text);
  } else {
    streamer.finish();
  }
  process.stdout.write("\n");

  if (!response.ok) {
    console.log(`\n[Reasoning Engine error] ${response.error}`);
    console.log("Hubi is currently unavailable -- please retry.");
    return;
  }

  const { text: finalText, turnKind, planningMode } = extractResponseTags(response.text);
  addTurn(session, "assistant", finalText);
  session.lastPlanningMode = planningMode;
  console.log(`\n[planningMode: ${planningMode}] [turnKind: ${turnKind}]`);
  if (verification.buffered) {
    console.log(
      `[Claim check] checked=${verification.checked} violations ${verification.violationsBefore} -> ${verification.violationsAfter}` +
        (verification.revised ? ` | revised (${verification.revisionAccepted ? "accepted" : "discarded"}, +${(verification.extraMs / 1000).toFixed(1)}s)` : "") +
        (verification.phrases.length ? ` | flagged: ${verification.phrases.join(", ")}` : "")
    );
  }

  console.log(`\n[Citations]`);
  results.forEach((r, i) => console.log(`  [${i + 1}] ${formatCitation(r.chunk)} [${formatApplicabilityLabel(r.chunk)}]`));
  console.log(`\n(response time: ${(response.durationMs / 1000).toFixed(1)}s)`);
}

async function main() {
  console.log("Hubi -- terminal Runtime Core");
  console.log(`Session State -> Lexical Retrieval -> Prompt Builder -> Reasoning Engine (${resolveReasoningProvider()}) -> Grounded Response -> Citation\n`);

  console.log(`Ingesting ${CONTENT_REPO}...`);
  const { documents, chunks, report } = ingestContentRepository(CONTENT_REPO);
  const failed = report.filter((r) => r.status === "failed");
  console.log(`Loaded ${documents.length} documents, ${chunks.length} chunks (${failed.length} failed).`);
  for (const f of failed) console.log(`  FAILED: ${f.file} -- ${f.reason}`);

  const { index, excluded } = buildGovernedIndex(chunks);
  for (const e of excluded) console.log(`Excluded by AI Eligibility (${e.aiEligibility}): ${e.contentId} (${e.chunkCount} chunks) -- never indexed.`);
  const session = createSession();

  const argQuestion = process.argv.slice(2).join(" ").trim();
  if (argQuestion) {
    await handleQuestion(argQuestion, index, session);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("\nAsk Hubi (or type 'exit'): ");
  rl.prompt();

  // Uses the persistent 'line' event rather than chained rl.question() calls.
  // question()'s one-shot re-arm pattern silently drops any input already
  // buffered in the stream once EOF is reached mid-turn (always true for
  // piped input, and possible interactively if a user sends a line while a
  // ~10s response is still in flight) -- 'line' does not have this problem.
  //
  // An explicit queue (not rl.pause()/resume()) serializes turns: when input
  // arrives in a fast burst, Node can emit multiple 'line' events before an
  // async handler's rl.pause() call actually takes effect, which let two
  // turns run concurrently and interleave their streamed output character by
  // character. The queue + `processing` flag below guarantees one turn
  // completes before the next starts, regardless of event timing.
  const queue: string[] = [];
  let processing = false;
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  async function drainQueue(): Promise<void> {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const line = queue.shift()!;
      await handleQuestion(line, index, session);
      if (!closed) rl.prompt();
    }
    processing = false;
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase() === "exit") {
      rl.close();
      return;
    }
    queue.push(trimmed);
    void drainQueue();
  });
}

main();
