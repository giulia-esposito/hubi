import { existsSync, readFileSync } from "node:fs";

// The deploy script (scripts/deploy.ts) writes build-info.json into the exported
// commit before building. Its values are inlined into the bundle here, so every
// telemetry entry and /api/health say exactly which commit is running. Absent
// in local development, where the code reports "unknown".
let buildInfo = {};
if (existsSync("build-info.json")) {
  try {
    buildInfo = JSON.parse(readFileSync("build-info.json", "utf8"));
  } catch {
    // A malformed file must never break a build.
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces .next/standalone -- a self-contained server bundle with only
  // the production dependencies actually used, traced automatically by
  // Next.js. This is what Dockerfile copies into the runtime image; it has
  // no effect on `next dev` and does not change local development at all.
  // See docs/gcp-deployment-guide.md "Cloud Run" for how the image is built
  // from this output.
  output: "standalone",
  env: {
    HUBI_BUILD_COMMIT: String(buildInfo.commit ?? ""),
    HUBI_BUILD_BRANCH: String(buildInfo.branch ?? ""),
    HUBI_BUILD_TIME: String(buildInfo.builtAt ?? ""),
  },
};

export default nextConfig;
