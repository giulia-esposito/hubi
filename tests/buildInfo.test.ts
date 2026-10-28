import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BUILD_INFO } from "../lib/runtime/buildInfo.ts";
import { buildTelemetryEntry } from "../lib/runtime/telemetry.ts";
import { GET as healthGet } from "../app/api/health/route.ts";

describe("build identity", () => {
  test("without a build the code reports 'unknown', never an empty or invented commit", () => {
    assert.equal(BUILD_INFO.commit, "unknown");
    assert.equal(BUILD_INFO.branch, "unknown");
    assert.equal(BUILD_INFO.builtAt, "unknown");
  });

  test("every telemetry entry carries the commit, so feedback maps to an exact build", () => {
    const entry = buildTelemetryEntry("feedback", { helpful: true }, { K_SERVICE: "hubi-pilot", K_REVISION: "hubi-pilot-00006-abc" });
    assert.equal(entry.commit, BUILD_INFO.commit);
    assert.equal(entry.revision, "hubi-pilot-00006-abc");
  });

  test("/api/health reports identity and never touches the knowledge base or the model", async () => {
    const saved = { K_SERVICE: process.env.K_SERVICE, K_REVISION: process.env.K_REVISION };
    process.env.K_SERVICE = "hubi-pilot";
    process.env.K_REVISION = "hubi-pilot-00006-abc";
    try {
      const res = await healthGet();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "ok");
      assert.equal(body.commit, BUILD_INFO.commit);
      assert.equal(body.service, "hubi-pilot");
      assert.equal(body.revision, "hubi-pilot-00006-abc");
      assert.equal(res.headers.get("Cache-Control"), "no-store");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
