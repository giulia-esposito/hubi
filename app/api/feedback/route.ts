import { logFeedback } from "../../../lib/runtime/interactionLog.ts";
import { sanitizeFeedbackTags } from "../../../lib/runtime/feedbackTags.ts";
import { actorForLog } from "../../../lib/runtime/actor.ts";
import { createRequestGuard } from "../../../lib/runtime/resilience.ts";
import { VALID_ID } from "../../../lib/runtime/requestSession.ts";

export const runtime = "nodejs";

const MAX_COMMENT_LENGTH = 2000;

// Feedback is cheap but unauthenticated input to the logs: cap how much one caller (and one instance) can write.
const guard = createRequestGuard({ perUserPerMinute: 30, perInstancePerHour: 3000 });

export async function POST(req: Request): Promise<Response> {
  const verdict = guard.check(req.headers.get("x-goog-authenticated-user-email") ?? "anonymous");
  if (!verdict.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    return new Response(JSON.stringify({ error: "rate-limited", retryAfterSec }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) } });
  }
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  const interactionId = typeof body?.interactionId === "string" ? body.interactionId : null;
  const helpful = typeof body?.helpful === "boolean" ? body.helpful : null;
  const rawComment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const comment = rawComment ? rawComment.slice(0, MAX_COMMENT_LENGTH) : undefined;
  const tags = sanitizeFeedbackTags(body?.tags);
  const waitMs = typeof body?.waitMs === "number" && Number.isFinite(body.waitMs) && body.waitMs >= 0 && body.waitMs <= 600000 ? Math.round(body.waitMs) : undefined;
  const buffered = typeof body?.buffered === "boolean" ? body.buffered : undefined;

  if (!sessionId || !interactionId || helpful === null || !VALID_ID.test(sessionId) || !VALID_ID.test(interactionId)) {
    return new Response(JSON.stringify({ error: "valid sessionId and interactionId (up to 100 letters, digits, - or _) and helpful are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  logFeedback({
    type: "feedback",
    timestamp: new Date().toISOString(),
    sessionId,
    interactionId,
    helpful,
    actor: actorForLog(req.headers),
    comment,
    tags: tags.length > 0 ? tags : undefined,
    waitMs,
    buffered,
  });

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
