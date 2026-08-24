import readline from "node:readline";
import { ingestContentRepository } from "../lib/ingestion/ingest.ts";
import { buildIndex, search, type RetrievalIndex } from "../lib/retrieval/index.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../lib/runtime/promptBuilder.ts";
import { formatCitation } from "../lib/runtime/citationBuilder.ts";
import { getReasoningEngine, resolveReasoningProvider } from "../lib/runtime/reasoningEngine.ts";
import { createSession, addTurn, accumulatedUserQuery, type Session } from "../lib/runtime/sessionState.ts";
import { createTagAwareStreamer, extractTurnKind } from "../lib/runtime/turnKind.ts";

const CONTENT_REPO = "Content Repository";
const TOP_K = 5;

async function handleQuestion(question: string, index: RetrievalIndex, session: Session): Promise<void> {
  const historyBeforeThisTurn = [...session.turns];
  addTurn(session, "user", question);

  // Retrieval uses every user message so far, not just this one -- see
  // lib/runtime/sessionState.ts for why (keeps a clarifying-question
  // exchange retrieving relevant content without a separate classifier).
  const retrievalQuery = accumulatedUserQuery(session);
  const results = search(index, retrievalQuery, TOP_K);

  console.log(`\n[Retrieval] ${results.length} chunk(s) matched.`);
  results.forEach((r, i) =>
    console.log(`  [${i + 1}] score=${r.score.toFixed(2)} ${r.chunk.documentTitle}${r.chunk.heading ? " -> " + r.chunk.heading : ""}`)
  );

  if (results.length === 0) {
    const refusal =
      "I don't have grounded information on this in the current knowledge base. " +
      "I won't guess -- try rephrasing, or this may be outside what's been ingested so far.";
    console.log(`\nHubi: ${refusal}`);
    addTurn(session, "assistant", refusal);
    return;
  }

  const prompt = buildPrompt(question, results, historyBeforeThisTurn);

  process.stdout.write("\nHubi: ");
  const streamer = createTagAwareStreamer((visible) => process.stdout.write(visible));
  const askReasoningEngine = getReasoningEngine();
  const response = await askReasoningEngine(prompt, HUBI_SYSTEM_PROMPT, {
    onDelta: (t) => streamer.push(t),
  });
  streamer.finish();
  process.stdout.write("\n");

  if (!response.ok) {
    console.log(`\n[Reasoning Engine error] ${response.error}`);
    console.log("Hubi is currently unavailable -- please retry.");
    return;
  }

  const { text: finalText, turnKind } = extractTurnKind(response.text);
  addTurn(session, "assistant", finalText);
  console.log(`\n[turnKind: ${turnKind}]`);

  console.log(`\n[Citations]`);
  results.forEach((r, i) => console.log(`  [${i + 1}] ${formatCitation(r.chunk)}`));
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

  const index = buildIndex(chunks);
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
