import { BUILD_INFO } from "../../../lib/runtime/buildInfo.ts";
import { knowledgeBaseState } from "../../../lib/runtime/knowledgeBase.ts";

export const runtime = "nodejs";

/**
 * Liveness plus identity: which commit and Cloud Run revision answered. It
 * never touches the knowledge base or the model, so it is cheap and cannot fail
 * for content or provider reasons. Used after a deploy or rollback to confirm
 * what is serving traffic (the service is behind IAP and internal ingress, so
 * it is reachable from inside the network only).
 */
export async function GET(req?: Request): Promise<Response> {
  // Liveness answers 200 whatever the knowledge base is doing; `?ready=1` is the readiness probe: 503 until the
  // corpus is loaded, so a probe can tell "process up" from "able to answer".
  const kb = knowledgeBaseState();
  const wantsReady = new URL(req?.url ?? "http://x").searchParams.get("ready") === "1";
  return new Response(
    JSON.stringify({
      status: "ok",
      knowledgeBase: kb,
      commit: BUILD_INFO.commit,
      branch: BUILD_INFO.branch,
      builtAt: BUILD_INFO.builtAt,
      service: process.env.K_SERVICE ?? null,
      revision: process.env.K_REVISION ?? null,
      provider: process.env.HUBI_REASONING_PROVIDER || "claude-code",
    }),
    { status: wantsReady && kb.status !== "ready" ? 503 : 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
