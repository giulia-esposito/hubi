import { getKnowledgeBase } from "../../../lib/runtime/knowledgeBase.ts";
import { getOrCreateSession } from "../../../lib/runtime/sessionRegistry.ts";
import { addTurn, accumulatedUserQuery } from "../../../lib/runtime/sessionState.ts";
import { retrieveApplicable } from "../../../lib/runtime/retrieveApplicable.ts";

import { regionLabel } from "../../../lib/applicability/evaluate.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../../../lib/runtime/promptBuilder.ts";
import { getReasoningEngine } from "../../../lib/runtime/reasoningEngine.ts";
import { createTagAwareStreamer, extractResponseTags } from "../../../lib/runtime/turnKind.ts";
import { logInteraction, type ApplicabilityLog, type SourceRef } from "../../../lib/runtime/interactionLog.ts";

// Route Handler must run in the Node.js runtime, not Edge. The Claude Code
// adapter spawns the `claude` CLI via child_process (Edge cannot do that);
// the Gemini adapter has no such requirement, but the runtime is pinned to
// Node.js unconditionally so switching HUBI_REASONING_PROVIDER never
// silently changes which Next.js runtime this route executes in.
export const runtime = "nodejs";

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
  const userMessages = session.turns.filter((t) => t.role === "user").map((t) => t.content);

  // Retrieval is unchanged; the Applicability Layer (Finding #002) then
  // filters what the model may see: mismatched regions never pass, region-
  // specific content is withheld until the user's region is known.
  const { raw, decision } = retrieveApplicable(index, retrievalQuery, userMessages);
  const results = decision.eligible;
  const sources: SourceRef[] = results.map((r, i) => ({
    documentTitle: r.chunk.documentTitle,
    heading: r.chunk.heading,
    citationUrl: r.chunk.citationUrl,
    regionLabel: regionLabel(r.chunk),
    regionStatus: decision.eligibleStatuses[i],
  }));
  const applicability: ApplicabilityLog = {
    taskRegions: decision.taskRegions,
    mode: decision.mode,
    withheldCount: decision.withheldCount,
    withheldRegions: decision.withheldRegions,
    mismatchCount: decision.mismatchCount,
    mismatchRegions: decision.mismatchRegions,
    unspecifiedUsed: decision.unspecifiedUsed,
  };

  const encoder = new TextEncoder();
  const start = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      send({
        type: "retrieval",
        chunkCount: results.length,
        sources,
        applicability: { mode: decision.mode, taskRegions: decision.taskRegions },
      });

      // Deterministic refusal only when retrieval itself found nothing. When
      // retrieval found content but the Applicability Layer gated all of it
      // (must-clarify / no-applicable-content), the model is still called, with
      // no retrieved content, so the reply comes back in the user's language.
      if (raw.length === 0) {
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
          // No model call happened, so no planning mode was determined.
          planningMode: "unknown",
          applicability,
          latencyMs: durationMs,
          ok: true,
        });

        send({ type: "done", ok: true, durationMs, interactionId, turnKind: "no-grounded-answer", planningMode: "unknown" });
        controller.close();
        return;
      }

      const prompt = buildPrompt(question, results, historyBeforeThisTurn, decision);
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

      // Authoritative turnKind/planningMode/text come from the full final
      // response, not the live streamer -- the streamer only exists to keep
      // the tags off the screen during streaming.
      const { text: finalText, turnKind, planningMode } = extractResponseTags(response.text);
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
        planningMode,
        applicability,
        latencyMs: durationMs,
        ok: true,
      });

      send({ type: "done", ok: true, durationMs, interactionId, turnKind, planningMode });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
