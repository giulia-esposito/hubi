import { getKnowledgeBase } from "../../../lib/runtime/knowledgeBase.ts";
import { getOrCreateSession } from "../../../lib/runtime/sessionRegistry.ts";
import { addTurn, accumulatedUserQuery } from "../../../lib/runtime/sessionState.ts";
import { search } from "../../../lib/retrieval/index.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../../../lib/runtime/promptBuilder.ts";
import { getReasoningEngine } from "../../../lib/runtime/reasoningEngine.ts";
import { createTagAwareStreamer, extractTurnKind } from "../../../lib/runtime/turnKind.ts";
import { logInteraction, type SourceRef } from "../../../lib/runtime/interactionLog.ts";

// Route Handler must run in the Node.js runtime, not Edge. The Claude Code
// adapter spawns the `claude` CLI via child_process (Edge cannot do that);
// the Gemini adapter has no such requirement, but the runtime is pinned to
// Node.js unconditionally so switching HUBI_REASONING_PROVIDER never
// silently changes which Next.js runtime this route executes in.
export const runtime = "nodejs";

const TOP_K = 5;

const NO_KNOWLEDGE_MESSAGE =
  "I don't have grounded information on this in the current knowledge base. " +
  "I won't guess -- try rephrasing, or this may be outside what's been ingested so far.";

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";

  if (!sessionId || !question) {
    return new Response(JSON.stringify({ error: "sessionId and question are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { index } = await getKnowledgeBase();
  const session = getOrCreateSession(sessionId);
  const historyBeforeThisTurn = [...session.turns];
  addTurn(session, "user", question);

  // Retrieval uses every user message so far, not just this one -- see
  // lib/runtime/sessionState.ts for why.
  const retrievalQuery = accumulatedUserQuery(session);
  const results = search(index, retrievalQuery, TOP_K);
  const sources: SourceRef[] = results.map((r) => ({
    documentTitle: r.chunk.documentTitle,
    heading: r.chunk.heading,
    citationUrl: r.chunk.citationUrl,
  }));

  const encoder = new TextEncoder();
  const start = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      send({ type: "retrieval", chunkCount: results.length, sources });

      if (results.length === 0) {
        // Deterministic, retrieval-level refusal -- no reasoning engine call.
        send({ type: "delta", text: NO_KNOWLEDGE_MESSAGE });
        addTurn(session, "assistant", NO_KNOWLEDGE_MESSAGE);

        const interactionId = crypto.randomUUID();
        const durationMs = Date.now() - start;
        logInteraction({
          type: "interaction",
          timestamp: new Date().toISOString(),
          sessionId,
          interactionId,
          question,
          response: NO_KNOWLEDGE_MESSAGE,
          sources,
          turnKind: "no-grounded-answer",
          latencyMs: durationMs,
          ok: true,
        });

        send({ type: "done", ok: true, durationMs, interactionId, turnKind: "no-grounded-answer" });
        controller.close();
        return;
      }

      const prompt = buildPrompt(question, results, historyBeforeThisTurn);
      const streamer = createTagAwareStreamer((visible) => send({ type: "delta", text: visible }));

      const askReasoningEngine = getReasoningEngine();
      const response = await askReasoningEngine(prompt, HUBI_SYSTEM_PROMPT, {
        onDelta: (t) => streamer.push(t),
      });
      streamer.finish();

      const durationMs = Date.now() - start;

      if (!response.ok) {
        send({ type: "done", ok: false, error: response.error, durationMs });
        controller.close();
        return;
      }

      // Authoritative turnKind/text comes from the full final response, not
      // the live streamer -- the streamer only exists to keep the tag off
      // the screen during streaming.
      const { text: finalText, turnKind } = extractTurnKind(response.text);
      addTurn(session, "assistant", finalText);

      const interactionId = crypto.randomUUID();
      logInteraction({
        type: "interaction",
        timestamp: new Date().toISOString(),
        sessionId,
        interactionId,
        question,
        response: finalText,
        sources,
        turnKind,
        latencyMs: durationMs,
        ok: true,
      });

      send({ type: "done", ok: true, durationMs, interactionId, turnKind });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
