import type { GoogleGenAI as GoogleGenAIType } from "@google/genai";
import type { ReasoningOptions, ReasoningResult } from "./reasoningEngine.claudeCode.ts";

/**
 * ReasoningEngine.generate() implemented against Gemini via Vertex AI, using
 * the same adapter contract as reasoningEngine.claudeCode.ts (see
 * reasoningEngine.ts). This is the intended runtime for the deployed Cloud
 * Run pilot; the local Claude Code adapter remains the development-time
 * default and is untouched by this file.
 *
 * Auth is entirely implicit: in Vertex AI mode the SDK uses Application
 * Default Credentials, which on Cloud Run means the service's attached
 * identity -- no API key, no service-account JSON file, nothing to rotate
 * or leak. Locally (only if a developer deliberately sets
 * HUBI_REASONING_PROVIDER=gemini to test this path outside Cloud Run), it
 * falls back to `gcloud auth application-default login` credentials.
 *
 * KNOWN VERIFICATION GAP (see docs/gcp-deployment-guide.md "Known
 * limitations" and migration step 7 "test one isolated Gemini/Vertex AI
 * call"): the @google/genai SDK's Vertex AI constructor option has been
 * documented under more than one name across recent major versions
 * (`vertexai: true` in the long-established, widely-documented form; some
 * newer docs refer to a renamed `enterprise: true` option for what they now
 * call the "Gemini Enterprise Agent Platform"). This file uses `vertexai`,
 * matching @google/genai ^2.18.0 (the version pinned in package.json at the
 * time this adapter was written) and the terminology Google Cloud's own
 * Vertex AI docs still use. Do not treat this as confirmed working, though:
 * this line has not been exercised against a live GCP project from this
 * environment. It is the single, isolated point to check first -- and the
 * entire reason migration step 7 exists as its own step rather than being
 * folded into building the full adapter blind.
 */
// Constructed lazily, on first actual call, not at module load. Importing
// this file (which happens unconditionally through reasoningEngine.ts,
// regardless of which provider is active) must never require GCP
// credentials, a resolvable project, or even the @google/genai package to
// already be installed -- local Claude Code development and the offline
// test suite both import this module transitively and must stay unaffected.
let ai: GoogleGenAIType | null = null;

async function getClient(): Promise<GoogleGenAIType> {
  if (!ai) {
    const { GoogleGenAI } = await import("@google/genai");
    ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
    });
  }
  return ai;
}

const MODEL = process.env.HUBI_GEMINI_MODEL || "gemini-2.5-flash";

export async function askGemini(
  preparedPrompt: string,
  systemPrompt: string,
  opts: ReasoningOptions = {}
): Promise<ReasoningResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();

  let finalText = "";
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    const run = async () => {
      // System prompt maps to systemInstruction; the prepared prompt (which
      // already carries retrieved knowledge + conversation history, per
      // lib/runtime/promptBuilder.ts) is sent as a single user turn -- the
      // same deliberate choice as the Claude Code adapter: Hubi's own
      // Session State stays the single source of truth for history, never
      // the provider's own session/context mechanism. This is what keeps
      // this file swappable in the first place.
      const client = await getClient();
      const stream = await client.models.generateContentStream({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: preparedPrompt }] }],
        config: { systemInstruction: systemPrompt },
      });

      for await (const chunk of stream) {
        const delta = chunk.text;
        if (delta) {
          finalText += delta;
          opts.onDelta?.(delta);
        }
      }
    };

    await Promise.race([run(), timeoutPromise]);

    return { ok: true, text: finalText, mode: "stream", durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      text: finalText,
      mode: "stream",
      durationMs: Date.now() - start,
      error: timedOut ? "timeout" : String((err as Error)?.message ?? err),
    };
  }
}
