#!/usr/bin/env node
// Migration sequence step 7: "test one isolated Gemini / Vertex AI call" --
// deliberately standalone, not routed through reasoningEngine.gemini.ts, so
// a failure here points unambiguously at auth/project/SDK setup rather than
// anything in Hubi's own adapter code. Mirrors the spirit of
// scripts/validate-phase0.mjs (which did the equivalent isolated check for
// Claude Code) without duplicating its structure.
//
// Prerequisites (see docs/gcp-deployment-guide.md):
//   - GOOGLE_CLOUD_PROJECT set to a project with Vertex AI enabled
//   - `gcloud auth application-default login` run on this machine
//     (or run from a Cloud Run instance with the hubi-runtime identity attached)
//
// Usage:
//   node scripts/validate-gemini.mjs

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const model = process.env.HUBI_GEMINI_MODEL || "gemini-2.5-flash";

if (!project) {
  console.error("FAIL: GOOGLE_CLOUD_PROJECT is not set. See docs/gcp-deployment-guide.md §5.");
  process.exit(1);
}

console.log(`Testing one isolated Gemini/Vertex AI call -- project=${project} location=${location} model=${model}`);

let GoogleGenAI;
try {
  ({ GoogleGenAI } = await import("@google/genai"));
} catch (err) {
  console.error("FAIL: could not import @google/genai. Run `npm install` first.");
  console.error(String(err?.message ?? err));
  process.exit(1);
}

// KNOWN UNCERTAINTY (see lib/runtime/reasoningEngine.gemini.ts and
// docs/gcp-deployment-guide.md §8): the constructor option for Vertex AI
// mode has been documented under more than one name across recent
// @google/genai versions ("vertexai: true" vs. a newer "enterprise: true").
// This script uses the same option the real adapter uses -- if this
// script fails with something like "Unknown configuration option", that is
// the first thing to check, and the fix belongs in exactly one place:
// lib/runtime/reasoningEngine.gemini.ts's getClient() function.
let ai;
try {
  ai = new GoogleGenAI({ vertexai: true, project, location });
} catch (err) {
  console.error("FAIL: GoogleGenAI construction with `vertexai: true` threw. See the comment above this line in the script.");
  console.error(String(err?.message ?? err));
  process.exit(1);
}

try {
  const start = Date.now();
  const response = await ai.models.generateContent({
    model,
    contents: "Reply with exactly one word: PONG",
  });
  const text = response.text?.trim();
  const durationMs = Date.now() - start;

  console.log(`Response received in ${durationMs}ms: "${text}"`);
  if (text && text.toUpperCase().includes("PONG")) {
    console.log("PASS: isolated Gemini/Vertex AI call succeeded.");
    process.exit(0);
  } else {
    console.log("PARTIAL: call succeeded but the response was unexpected -- inspect manually before trusting the adapter.");
    process.exit(0);
  }
} catch (err) {
  console.error("FAIL: the call itself failed (auth, project/location, model access, or network).");
  console.error(String(err?.message ?? err));
  console.error("\nCommon causes: `gcloud auth application-default login` not run, Vertex AI API not enabled, or this model not available in the chosen location.");
  process.exit(1);
}
