/**
 * Runs once when the server process starts (Next.js instrumentation hook). It
 * emits a `startup` telemetry event so that, right after a deploy or rollback,
 * Cloud Logging shows which commit and revision came up and with which pilot
 * settings, without waiting for a tester's first request. scripts/deploy.ts
 * `verify` reads it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { emitTelemetry, telemetryTarget } = await import("./lib/runtime/telemetry.ts");
  const { BUILD_INFO } = await import("./lib/runtime/buildInfo.ts");
  const { verificationEnabled } = await import("./lib/runtime/verifiedGeneration.ts");
  const { getRegionVocabulary } = await import("./lib/applicability/regions.ts");
  emitTelemetry("startup", {
    type: "startup",
    timestamp: new Date().toISOString(),
    buildBranch: BUILD_INFO.branch,
    builtAt: BUILD_INFO.builtAt,
    claimVerifierEnabled: verificationEnabled(),
    logTarget: telemetryTarget(),
    contentSource: process.env.HUBI_CONTENT_SOURCE || "local",
    regionConfigWarnings: getRegionVocabulary().warnings.length,
  });
}
