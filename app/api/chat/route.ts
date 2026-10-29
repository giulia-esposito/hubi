import { getKnowledgeBase } from "../../../lib/runtime/knowledgeBase.ts";
import { getOrCreateSession } from "../../../lib/runtime/sessionRegistry.ts";
import { describeHistory, parseChatRequest, sessionFromRequest } from "../../../lib/runtime/requestSession.ts";
import { addTurn, accumulatedUserQuery } from "../../../lib/runtime/sessionState.ts";
import { retrieveApplicable } from "../../../lib/runtime/retrieveApplicable.ts";
import { expandQuery, expansionEnabled } from "../../../lib/retrieval/queryExpansion.ts";

import { regionLabel } from "../../../lib/applicability/evaluate.ts";
import { buildPrompt, HUBI_SYSTEM_PROMPT } from "../../../lib/runtime/promptBuilder.ts";
import { getReasoningEngine } from "../../../lib/runtime/reasoningEngine.ts";
import { createRequestGuard } from "../../../lib/runtime/resilience.ts";
import { actorForLog, callerKindFromHeaders } from "../../../lib/runtime/actor.ts";
import { emitTelemetry } from "../../../lib/runtime/telemetry.ts";
import { createTagAwareStreamer, extractResponseTags } from "../../../lib/runtime/turnKind.ts";
import { generateWithVerification, ledgerEnabled, shouldVerify } from "../../../lib/runtime/verifiedGeneration.ts";
import { logInteraction, logInteractionError, type ApplicabilityLog, type ContinuityLog, type RetrievalLog, type SourceRef } from "../../../lib/runtime/interactionLog.ts";
import { sourceFactsLog } from "../../../lib/governance/sourceFacts.ts";
import { detectSourceGovernance } from "../../../lib/governance/sourceGovernance.ts";

// Route Handler must run in the Node.js runtime, not Edge. The Claude Code
// adapter spawns the `claude` CLI via child_process (Edge cannot do that);
// the Gemini adapter has no such requirement, but the runtime is pinned to
// Node.js unconditionally so switching HUBI_REASONING_PROVIDER never
// silently changes which Next.js runtime this route executes in.
export const runtime = "nodejs";

const NO_KNOWLEDGE_MESSAGE =
  "I don't have grounded information on this in the current knowledge base. " +
  "I won't guess -- try rephrasing, or this may be outside what's been ingested so far.";

// One guard per server process: a backstop against a runaway client or loop, not an exact quota
// (each instance keeps its own windows; see lib/runtime/resilience.ts).
const requestGuard = createRequestGuard();

export async function POST(req: Request): Promise<Response> {
  // Behind IAP the caller is the authenticated user; locally every caller shares one bucket.
  const callerKey = req.headers.get("x-goog-authenticated-user-email") ?? "anonymous";
  // Written to the audit log only when HUBI_LOG_ACTOR=1 (lib/runtime/actor.ts).
  const actor = actorForLog(req.headers);
  const callerKind = callerKindFromHeaders(req.headers);
  const verdict = requestGuard.check(callerKey);
  if (!verdict.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    emitTelemetry("interaction_error", { type: "interaction_error", timestamp: new Date().toISOString(), error: `rate-limited (${verdict.scope})`, retryAfterSec });
    return new Response(JSON.stringify({ error: "rate-limited", scope: verdict.scope, retryAfterSec }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) },
    });
  }
  const body = await req.json().catch(() => null);
  const parsed = parseChatRequest(body);

  if (!parsed.ok) {
    return new Response(JSON.stringify({ error: parsed.error }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { sessionId, question } = parsed.value;

  const { index } = await getKnowledgeBase();
  // Continuity must not depend on which Cloud Run instance serves this turn:
  // the browser sends the prior turns and the session is rebuilt from them
  // (lib/runtime/requestSession.ts). A client that sends no history (an older
  // one) falls back to this instance's memory.
  const clientHistory = parsed.value.history !== undefined;
  const session = clientHistory ? sessionFromRequest(parsed.value) : getOrCreateSession(sessionId);
  const historyReport = parsed.value.historyReport;
  const continuity: ContinuityLog = {
    source: clientHistory ? "client-history" : "instance-memory",
    priorTurns: session.turns.length,
    // The client supplies the history, so record exactly what was received and used.
    history: clientHistory ? describeHistory(session.turns, historyReport) : undefined,
  };
  // A context loss is never silent: tell the user when the caps dropped earlier turns.
  const historyNotice =
    historyReport && (historyReport.droppedOldest > 0 || historyReport.truncatedTurns > 0)
      ? { droppedOldest: historyReport.droppedOldest, truncatedTurns: historyReport.truncatedTurns }
      : undefined;
  const historyBeforeThisTurn = [...session.turns];
  addTurn(session, "user", question);

  // Retrieval uses every user message so far, not just this one -- see
  // lib/runtime/sessionState.ts for why.
  const retrievalQuery = accumulatedUserQuery(session);
  const userMessages = session.turns.filter((t) => t.role === "user").map((t) => t.content);

  // Retrieval is unchanged; the Applicability Layer (Finding #002) then
  // filters what the model may see: mismatched regions never pass, region-
  // specific content is withheld until the user's region is known.
  // Cross-language recall: one cheap model call, only for a non-English or weakly matched question; a failure falls back to plain BM25.
  const expansion = expansionEnabled()
    ? await expandQuery({ engine: getReasoningEngine(), index, query: retrievalQuery, latestMessage: question })
    : undefined;
  const { raw, decision, factPass, retrievalMs, regionSource } = retrieveApplicable(index, retrievalQuery, userMessages, {
    lastPlanningMode: session.lastPlanningMode,
    pinned: parsed.value.pinned,
    expansion: expansion?.terms ? expansion : undefined,
  });
  const results = decision.eligible;
  const sourceSignal = detectSourceGovernance(results);
  const sources: SourceRef[] = results.map((r, i) => ({
    documentTitle: r.chunk.documentTitle,
    heading: r.chunk.heading,
    citationUrl: r.chunk.citationUrl,
    regionLabel: regionLabel(r.chunk),
    regionStatus: decision.eligibleStatuses[i],
    chunkId: r.chunk.id,
    documentId: r.chunk.documentId,
    score: Math.round(r.score * 100) / 100,
    pass: i < (decision.factSourceCount ?? 0) ? "facts" : "request-match",
    governance: r.chunk.governance?.status,
    restriction: r.chunk.governance?.restriction,
    ...sourceFactsLog(r.chunk),
  }));
  const retrieval: RetrievalLog = {
    query: retrievalQuery,
    expansion: expansion?.triggered ? { triggered: true, reason: expansion.reason, language: expansion.language, terms: expansion.terms, ms: expansion.ms, error: expansion.error } : undefined,
    rawTop: raw.slice(0, 10).map((r) => ({
      chunkId: r.chunk.id,
      documentId: r.chunk.documentId,
      score: Math.round(r.score * 100) / 100,
      regionScope: r.chunk.regionScope,
    })),
  };
  const applicability: ApplicabilityLog = {
    taskRegions: decision.taskRegions,
    taskCountries: decision.taskCountries,
    regionSource,
    mode: decision.mode,
    withheldCount: decision.withheldCount,
    clarifyReason: decision.clarifyReason,
    audienceConflict: decision.audienceConflict?.groups,
    withheldRegions: decision.withheldRegions,
    mismatchCount: decision.mismatchCount,
    mismatchRegions: decision.mismatchRegions,
    unspecifiedUsed: decision.unspecifiedUsed,
    factPass: { triggered: factPass.triggered, reason: factPass.reason, added: factPass.added, query: factPass.query },
    retrievalMs: Math.round(retrievalMs * 10) / 10,
  };

  // Pilot claim guardrail (lib/runtime/verifiedGeneration.ts): turns that may be
  // artifact requests are buffered so the draft can be checked before the user
  // sees it. Gated turns (a short clarifying question or a no-content notice)
  // keep streaming: there is nothing to verify in them.
  const gated = decision.mode === "must-clarify" || decision.mode === "no-applicable-content";
  const bufferForVerification = shouldVerify(question, session.lastPlanningMode) && !gated;

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
        // Pilot claim guardrail: a buffered turn shows nothing until the whole
        // answer is drafted and checked, so the UI needs to say so.
        buffered: bufferForVerification && raw.length > 0,
        // Set when the history caps dropped earlier turns from this answer's context.
        historyNotice,
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
          retrieval,
          continuity,
          latencyMs: durationMs,
          actor,
          callerKind,
          ok: true,
        });

        send({
          type: "done",
          ok: true,
          durationMs,
          interactionId,
          turnKind: "no-grounded-answer",
          planningMode: "unknown",
          pinned: { regions: decision.taskRegions, countries: decision.taskCountries },
        });
        controller.close();
        return;
      }

      // The claims ledger rides only on buffered (verified) turns, so it can never reach a streamed answer.
      const useLedger = bufferForVerification && ledgerEnabled();
      const prompt = buildPrompt(question, results, historyBeforeThisTurn, decision, { ledger: useLedger });
      const streamer = createTagAwareStreamer((visible) => send({ type: "delta", text: visible }));

      // Verify-and-revise (prototype, HUBI_VERIFY_CLAIMS=1): turns that may be
      // artifact requests are buffered so the draft can be checked before the
      // user sees it; everything else keeps streaming token by token.
      const verify = bufferForVerification;
      let generated: Awaited<ReturnType<typeof generateWithVerification>>;
      try {
        generated = await generateWithVerification({
          engine: getReasoningEngine(),
          prompt,
          systemPrompt: HUBI_SYSTEM_PROMPT,
          retrievedTexts: results.map((r) => r.chunk.text),
          verify,
          ledger: useLedger,
          onDelta: (t) => streamer.push(t),
        });
      } catch (err) {
        // An unexpected failure must be visible in the pilot logs, not just a blank answer.
        logInteractionError({
          type: "interaction_error",
          timestamp: new Date().toISOString(),
          sessionId,
          interactionId: crypto.randomUUID(),
          question,
          error: String((err as Error)?.message ?? err),
          latencyMs: Date.now() - start,
          actor,
          callerKind,
          applicability,
          retrieval,
          continuity,
          buffered: verify,
        });
        send({ type: "done", ok: false, error: "unexpected error", durationMs: Date.now() - start });
        controller.close();
        return;
      }
      const { response, verification } = generated;
      if (verify) {
        if (response.ok) send({ type: "delta", text: extractResponseTags(response.text).text });
      } else {
        streamer.finish();
      }

      const durationMs = Date.now() - start;

      if (!response.ok) {
        logInteractionError({
          type: "interaction_error",
          timestamp: new Date().toISOString(),
          sessionId,
          interactionId: crypto.randomUUID(),
          question,
          error: String(response.error ?? "reasoning engine failed"),
          latencyMs: durationMs,
          actor,
          callerKind,
          engineAttempts: response.attempts,
          engineRetryWaitMs: response.retryWaitMs,
          applicability,
          retrieval,
          continuity,
          buffered: verify,
        });
        send({ type: "done", ok: false, error: response.error, durationMs });
        controller.close();
        return;
      }

      // Authoritative turnKind/planningMode/text come from the full final
      // response, not the live streamer -- the streamer only exists to keep
      // the tags off the screen during streaming.
      const { text: finalText, turnKind, planningMode } = extractResponseTags(response.text);
      addTurn(session, "assistant", finalText);
      session.lastPlanningMode = planningMode;

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
        retrieval,
        continuity,
        sourceGovernance: sourceSignal ?? undefined,
        buffered: verification.buffered,
        modelMs: response.durationMs,
        verification: verification.buffered ? verification : undefined,
        latencyMs: durationMs,
          actor,
          callerKind,
        engineAttempts: response.attempts,
        engineRetryWaitMs: response.retryWaitMs,
        ok: true,
      });

      send({
        type: "done",
        ok: true,
        durationMs,
        interactionId,
        turnKind,
        planningMode,
        buffered: verification.buffered,
        verification: verification.buffered
          ? { checked: verification.checked, revised: verification.revised, accepted: verification.revisionAccepted }
          : undefined,
        // Region and country in force; the client sends them back so they outlive the history window.
        pinned: { regions: decision.taskRegions, countries: decision.taskCountries },
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
