import { askClaudeCode } from "./reasoningEngine.claudeCode.ts";
import { askGemini } from "./reasoningEngine.gemini.ts";

export type { ReasoningResult, ReasoningOptions } from "./reasoningEngine.claudeCode.ts";
import type { ReasoningOptions, ReasoningResult } from "./reasoningEngine.claudeCode.ts";

/**
 * The provider-agnostic contract every Reasoning Engine adapter implements.
 * Hubi's runtime (app/api/chat/route.ts) depends only on this shape -- it
 * never knows or cares whether a call ends up at the local Claude Code CLI
 * or at Gemini via Vertex AI. Both existing adapters (askClaudeCode,
 * askGemini) already conform to this signature without modification; this
 * file only adds the selection layer on top.
 */
export type ReasoningEngine = (
  preparedPrompt: string,
  systemPrompt: string,
  opts?: ReasoningOptions
) => Promise<ReasoningResult>;

export type ReasoningProvider = "claude-code" | "gemini";

const PROVIDERS: Record<ReasoningProvider, ReasoningEngine> = {
  "claude-code": askClaudeCode,
  gemini: askGemini,
};

/**
 * Selects the active provider from HUBI_REASONING_PROVIDER.
 *
 * Default is "claude-code" -- the local development experience is
 * unaffected by this migration unless a developer (or the deployed
 * container) explicitly opts into Gemini. The deployed Cloud Run container
 * is the only place this should ever be set to "gemini" (see
 * docs/gcp-deployment-guide.md); local Claude Code development keeps
 * working exactly as before by simply not setting the variable.
 */
export function resolveReasoningProvider(): ReasoningProvider {
  const raw = process.env.HUBI_REASONING_PROVIDER?.trim().toLowerCase();
  if (raw === "gemini") return "gemini";
  if (raw === "claude-code" || !raw) return "claude-code";
  throw new Error(
    `Unknown HUBI_REASONING_PROVIDER "${raw}" -- expected "claude-code" or "gemini".`
  );
}

/**
 * Returns the ReasoningEngine function for the currently configured
 * provider. This is the only function app/api/chat/route.ts should import
 * -- it must never import reasoningEngine.claudeCode.ts or
 * reasoningEngine.gemini.ts directly, or the provider-selection point
 * silently duplicates.
 */
export function getReasoningEngine(): ReasoningEngine {
  return PROVIDERS[resolveReasoningProvider()];
}
