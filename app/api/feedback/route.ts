import { logFeedback } from "../../../lib/runtime/interactionLog.ts";

export const runtime = "nodejs";

const MAX_COMMENT_LENGTH = 2000;

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  const interactionId = typeof body?.interactionId === "string" ? body.interactionId : null;
  const helpful = typeof body?.helpful === "boolean" ? body.helpful : null;
  const rawComment = typeof body?.comment === "string" ? body.comment.trim() : "";
  const comment = rawComment ? rawComment.slice(0, MAX_COMMENT_LENGTH) : undefined;

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
  });

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
