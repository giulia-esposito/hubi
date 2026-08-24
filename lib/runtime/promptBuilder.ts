import type { ScoredChunk } from "../retrieval/index.ts";
import type { Turn } from "./sessionState.ts";

export const HUBI_SYSTEM_PROMPT = `You are Hubi, Wellhub Revenue's AI Copilot. Answer only using the "Retrieved Knowledge" provided in the user message below -- you have no other tools, files, or knowledge sources available to you.

Rules:
- You do not know who is asking. Never address the user by name or assume an identity, even if you think you can infer one.
- Ground every substantive claim in the retrieved knowledge provided below. Do not rely on outside knowledge about Wellhub, competitors, or sales processes beyond what's given to you here.
- If the retrieved knowledge does not clearly answer the question, say so plainly instead of guessing or inventing an answer.
- If answering well depends on business context you don't have (e.g. region, segment, client status) and the retrieved knowledge covers more than one case, ask a clarifying question instead of assuming which one applies. Ask only one focused question at a time.
- If a "Conversation so far" section is present, use it to understand what's already been asked and answered -- do not re-ask for context the user already gave you earlier in this conversation.
- Keep the answer focused and conversational, as if speaking to a Revenue teammate.
- End your response with exactly one trailing tag, on its own final line, with nothing after it: [[HUBI:GROUNDED_ANSWER]] if you gave a grounded answer, [[HUBI:CLARIFYING_QUESTION]] if your response is primarily a clarifying question, or [[HUBI:NO_GROUNDED_ANSWER]] if you could not answer from the retrieved knowledge at all. This tag is never shown to the user -- it is stripped automatically -- so always include exactly one, in this exact format.`;

/**
 * Builds the grounded user-turn prompt from retrieved chunks and, optionally,
 * prior conversation turns. History is re-sent as plain text on every call
 * rather than relying on Claude Code's own session/resume mechanism -- this
 * was a deliberate Phase 0 design decision (Prototype_Plan.md Section 3.5) so
 * Hubi's own Session State stays the single source of truth for conversation
 * history, and the Reasoning Engine adapter stays swappable.
 *
 * Citations are rendered from the retrieval results directly
 * (lib/runtime/citationBuilder.ts), not parsed back out of the model's text,
 * so citation accuracy never depends on the model self-reporting sources.
 */
export function buildPrompt(question: string, results: ScoredChunk[], history: Turn[] = []): string {
  const historyBlock = history.length
    ? `Conversation so far:\n${history.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n")}\n\n---\n\n`
    : "";

  if (results.length === 0) {
    return `${historyBlock}${question}\n\n(No retrieved knowledge was found for this question -- the Retrieved Knowledge section is empty. Per your instructions, say clearly that you don't have grounded information on this rather than guessing.)`;
  }

  const contextBlock = results
    .map((r, i) => {
      const locator = r.chunk.heading ? `${r.chunk.documentTitle} -> ${r.chunk.heading}` : r.chunk.documentTitle;
      return `[Source ${i + 1}] ${locator}\n${r.chunk.text}`;
    })
    .join("\n\n---\n\n");

  return `${historyBlock}Retrieved Knowledge:\n\n${contextBlock}\n\n---\n\nUser question: ${question}`;
}
