import { logFeedback } from "../../../lib/runtime/interactionLog.ts";
import { sanitizeFeedbackTags } from "../../../lib/runtime/feedbackTags.ts";

export const runtime = "nodejs";

const MAX_COMMENT_LENGTH = 2000;

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  const interactionId = typeof body?.interactionId === "string" ? body.interactionId : null;
  const helpful = typeof body?.helpful === "boolean" ? body.helpful : null;
  const rawComment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const comment = rawComment ? rawComment.slice(0, MAX_COMMENT_LENGTH) : undefined;
  const tags = sanitizeFeedbackTags(body?.tags);
  const waitMs = typeof body?.waitMs === "number" && Number.isFinite(body.waitMs) && body.waitMs >= 0 && body.waitMs <= 600000 ? Math.round(body.waitMs) : undefined;
  const buffered = typeof body?.buffered === "boolean" ? body.buffered : undefined;

  if (!sessionId || !interactionId || helpful === null) {
    return new Response(JSON.stringify({ error: "sessionId, interactionId, and helpful are required" }), {
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
    comment,
    tags: tags.length > 0 ? tags : undefined,
    waitMs,
    buffered,
  });

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
