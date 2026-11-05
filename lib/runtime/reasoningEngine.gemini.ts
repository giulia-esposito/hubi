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

type Env = Record<string, string | undefined>;

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

/** Tokens used by this process so far (successful calls). Read by the evals to report what a run cost. */
export const usageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

function recordUsage(usage: UsageMetadata | undefined): void {
  usageTotals.calls++;
  usageTotals.inputTokens += usage?.promptTokenCount ?? 0;
  usageTotals.outputTokens += usage?.candidatesTokenCount ?? 0;
  usageTotals.thinkingTokens += usage?.thoughtsTokenCount ?? 0;
}

// HUBI_USAGE_REPORT=1 prints the totals when the process ends (evals; billing is output tokens including thinking).
if (process.env.HUBI_USAGE_REPORT === "1") {
  process.on("exit", () => console.log(`[usage] ${JSON.stringify(usageTotals)}`));
}

// Grounded answers should not vary run to run: before these were set, the model's default
// sampling (temperature about 1.0) made identical code score 5/20 to 13/20 on the same eval.
// maxOutputTokens also counts the model's thinking tokens on Gemini 2.5, so it is generous.
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TOP_P = 0.9;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

function numberFrom(raw: string | undefined, fallback: number | undefined, min: number, max: number): number | undefined {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Generation settings from HUBI_GEMINI_TEMPERATURE, _TOP_P, _MAX_OUTPUT_TOKENS and _SEED (unset or invalid
 * values keep the defaults; there is no default seed). A helper call (`fast`: query expansion, scope judge)
 * is always deterministic and skips extended thinking.
 */
/**
 * Explicit content-safety thresholds, so behavior does not depend on a model default that can change under us.
 * BLOCK_ONLY_HIGH keeps ordinary business content (competition, discounts, "kill the deal") from being blocked while
 * still stopping clearly harmful output. A blocked answer comes back empty and is handled as "no grounded answer".
 */
export const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

export function generationConfig(fast: boolean | undefined, env: Env = process.env): Record<string, unknown> {
  const seed = numberFrom(env.HUBI_GEMINI_SEED, undefined, 0, 2_147_483_647);
  return {
    temperature: fast ? 0 : numberFrom(env.HUBI_GEMINI_TEMPERATURE, DEFAULT_TEMPERATURE, 0, 2),
    topP: numberFrom(env.HUBI_GEMINI_TOP_P, DEFAULT_TOP_P, 0, 1),
    safetySettings: SAFETY_SETTINGS,
    maxOutputTokens: Math.floor(numberFrom(env.HUBI_GEMINI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 256, 65_536) ?? DEFAULT_MAX_OUTPUT_TOKENS),
    ...(seed !== undefined ? { seed: Math.floor(seed) } : {}),
    ...(fast ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
}

export async function askGemini(
  preparedPrompt: string,
  systemPrompt: string,
  opts: ReasoningOptions = {}
): Promise<ReasoningResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();

  let finalText = "";
  let timedOut = false;
  // One controller ends the provider call for either reason: our timeout or the caller leaving. Aborting stops the
  // stream itself (no tokens are generated or billed for an answer nobody will read) and frees the concurrency slot.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (opts.signal?.aborted) return { ok: false, text: "", mode: "stream", durationMs: 0, error: "aborted" };
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
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
      config: { systemInstruction: systemPrompt, abortSignal: controller.signal, ...generationConfig(opts.fast) },
    });

    let lastUsage: UsageMetadata | undefined;
    for await (const chunk of stream) {
      if (controller.signal.aborted) break;
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
      const delta = chunk.text;
      if (delta) {
        finalText += delta;
        opts.onDelta?.(delta);
      }
    }
    if (controller.signal.aborted) throw new Error("aborted");
    recordUsage(lastUsage);

    return { ok: true, text: finalText, mode: "stream", durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      text: finalText,
      mode: "stream",
      durationMs: Date.now() - start,
      error: timedOut ? "timeout" : opts.signal?.aborted ? "aborted" : String((err as Error)?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}
