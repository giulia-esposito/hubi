import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TELEMETRY_SCHEMA, buildTelemetryEntry, capStrings, emitTelemetry, telemetryTarget } from "../lib/runtime/telemetry.ts";
import { logFeedback } from "../lib/runtime/interactionLog.ts";
import { POST as feedbackPost } from "../app/api/feedback/route.ts";

// Offline. What is verified is the exact shape Cloud Run turns into a
// structured Cloud Logging entry (one JSON object per line on stdout) and that
// it can never break a request; actual ingestion into Cloud Logging is standard
// Cloud Run behavior and can only be confirmed after a deploy.

const CLOUD_RUN = { K_SERVICE: "hubi-pilot", K_REVISION: "hubi-pilot-00006-abc", HUBI_REASONING_PROVIDER: "gemini" };

/** Runs fn with process.stdout.write and process.env patched; returns the stdout lines written. */
async function captureStdout(env: Record<string, string | undefined>, fn: () => unknown | Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = realWrite;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return lines.join("").split("\n").filter((l) => l.trim().startsWith("{"));
}

describe("telemetryTarget", () => {
  test("on Cloud Run entries go to stdout (Cloud Logging) and not to a file that would be lost", () => {
    assert.deepEqual(telemetryTarget({ K_SERVICE: "hubi-pilot" }), { stdout: true, file: false });
  });

  test("locally entries go to the file as before, not to stdout", () => {
    assert.deepEqual(telemetryTarget({}), { stdout: false, file: true });
  });

  test("explicit flags override the environment", () => {
    assert.deepEqual(telemetryTarget({ HUBI_LOG_STDOUT: "1" }), { stdout: true, file: true });
    assert.deepEqual(telemetryTarget({ K_SERVICE: "x", HUBI_LOG_STDOUT: "0", HUBI_LOG_FILE: "1" }), { stdout: false, file: true });
  });
});

describe("buildTelemetryEntry", () => {
  test("has the fields Cloud Logging and the pilot queries rely on", () => {
    const entry = buildTelemetryEntry("feedback", { type: "feedback", sessionId: "s", interactionId: "i", helpful: false }, CLOUD_RUN);
    assert.equal(entry.severity, "INFO");
    assert.equal(entry.message, "hubi.feedback");
    assert.equal(entry.component, "hubi");
    assert.equal(entry.event, "feedback");
    assert.equal(entry.schema, TELEMETRY_SCHEMA);
    assert.equal(entry.service, "hubi-pilot");
    assert.equal(entry.revision, "hubi-pilot-00006-abc");
    assert.equal(entry.provider, "gemini");
    assert.equal(entry.model, "gemini-2.5-flash");
    assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  });

  test("severity: errors are ERROR, failed interactions WARNING, the rest INFO", () => {
    assert.equal(buildTelemetryEntry("interaction_error", { error: "x" }, CLOUD_RUN).severity, "ERROR");
    assert.equal(buildTelemetryEntry("interaction", { ok: false }, CLOUD_RUN).severity, "WARNING");
    assert.equal(buildTelemetryEntry("interaction", { ok: true }, CLOUD_RUN).severity, "INFO");
  });

  test("carries feedback tags, waitMs and buffered state", () => {
    const entry = buildTelemetryEntry("feedback", { tags: ["too-slow"], waitMs: 13572, buffered: true, helpful: true }, CLOUD_RUN);
    assert.deepEqual(entry.tags, ["too-slow"]);
    assert.equal(entry.waitMs, 13572);
    assert.equal(entry.buffered, true);
  });

  test("carries the verification event with the original draft, the final answer, and retrieval metadata for diagnosis", () => {
    const record = {
      type: "interaction",
      response: "FINAL TEXT",
      verification: { checked: true, violationsBefore: 2, violationsAfter: 0, revised: true, revisionAccepted: true, phrases: ["42%", "retaining"], extraMs: 9000, draft: "ORIGINAL DRAFT" },
      sources: [{ documentTitle: "Doc", chunkId: "c1", documentId: "d1", score: 12.3, pass: "facts", regionStatus: "unspecified" }],
      retrieval: { query: "q", rawTop: [{ chunkId: "c1", documentId: "d1", score: 12.3 }] },
      buffered: true,
      modelMs: 15000,
    };
    const entry = buildTelemetryEntry("interaction", record, CLOUD_RUN) as typeof record & Record<string, unknown>;
    assert.equal(entry.verification.draft, "ORIGINAL DRAFT");
    assert.equal(entry.response, "FINAL TEXT");
    assert.deepEqual(entry.verification.phrases, ["42%", "retaining"]);
    assert.equal(entry.sources[0].chunkId, "c1");
    assert.equal(entry.sources[0].pass, "facts");
    assert.equal(entry.retrieval.rawTop[0].chunkId, "c1");
    assert.equal(entry.buffered, true);
  });

  test("a record's own timestamp is kept", () => {
    assert.equal(buildTelemetryEntry("interaction", { timestamp: "2026-10-29T10:00:00.000Z" }, CLOUD_RUN).timestamp, "2026-10-29T10:00:00.000Z");
  });
});

describe("size limits", () => {
  test("capStrings truncates long strings anywhere in the structure and leaves other values alone", () => {
    const out = capStrings({ a: "x".repeat(50), n: 7, ok: true, nested: { arr: ["y".repeat(50), "short"] } }, 10);
    assert.equal(out.a, "x".repeat(10) + "...[truncated]");
    assert.equal(out.n, 7);
    assert.equal(out.ok, true);
    assert.equal(out.nested.arr[0], "y".repeat(10) + "...[truncated]");
    assert.equal(out.nested.arr[1], "short");
  });

  test("a single very long field is capped, never dropped", () => {
    const entry = buildTelemetryEntry("interaction", { response: "z".repeat(100_000) }, CLOUD_RUN);
    assert.ok(String(entry.response).length < 21_000);
    assert.ok(String(entry.response).endsWith("...[truncated]"));
  });

  test("an entry that would still exceed the limit is shrunk and marked, staying under Cloud Logging's 256 KB", () => {
    const huge = Array.from({ length: 30 }, () => "w".repeat(19_000));
    const entry = buildTelemetryEntry("interaction", { drafts: huge }, CLOUD_RUN);
    assert.equal(entry.truncated, true);
    assert.ok(JSON.stringify(entry).length < 256_000);
  });
});

describe("emitTelemetry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("on Cloud Run it writes exactly one parseable JSON line per event to stdout", async () => {
    const lines = await captureStdout({}, () => emitTelemetry("feedback", { sessionId: "s", interactionId: "i", helpful: true, tags: ["too-slow"] }, CLOUD_RUN));
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "feedback");
    assert.equal(entry.interactionId, "i");
  });

  test("locally it appends to the file and keeps stdout quiet", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hubi-telemetry-"));
    dirs.push(dir);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const lines = await captureStdout({}, () => emitTelemetry("interaction", { sessionId: "s", ok: true }, {}));
      assert.equal(lines.length, 0);
      const file = path.join(dir, "logs", "interactions.jsonl");
      assert.ok(existsSync(file));
      assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).event, "interaction");
    } finally {
      process.chdir(cwd);
    }
  });

  test("a stdout failure never throws into the request", () => {
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => {
      throw new Error("EPIPE");
    }) as typeof process.stdout.write;
    try {
      assert.doesNotThrow(() => emitTelemetry("feedback", { a: 1 }, CLOUD_RUN));
    } finally {
      process.stdout.write = realWrite;
    }
  });

  test("unserializable data never throws into the request", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => emitTelemetry("interaction", circular, CLOUD_RUN));
  });
});

describe("feedback route -> telemetry", () => {
  const post = (body: unknown) =>
    feedbackPost(new Request("http://localhost/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  test("a tester's feedback, tags, wait time and buffered state reach stdout as one structured entry", async () => {
    let status = 0;
    const lines = await captureStdout(CLOUD_RUN, async () => {
      status = (await post({ sessionId: "s1", interactionId: "i1", helpful: false, comment: "slow", tags: ["too-slow", "bogus", "scope-or-causality"], waitMs: 13572, buffered: true })).status;
    });
    assert.equal(status, 200);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "feedback");
    assert.equal(entry.helpful, false);
    assert.deepEqual(entry.tags, ["too-slow", "scope-or-causality"]);
    assert.equal(entry.waitMs, 13572);
    assert.equal(entry.buffered, true);
    assert.equal(entry.revision, "hubi-pilot-00006-abc");
  });

  test("an implausible waitMs is dropped, not logged", async () => {
    const lines = await captureStdout(CLOUD_RUN, async () => {
      await post({ sessionId: "s", interactionId: "i", helpful: true, waitMs: -5 });
      await post({ sessionId: "s", interactionId: "i", helpful: true, waitMs: 99_999_999 });
    });
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(JSON.parse(l).waitMs, undefined);
  });

  test("logFeedback emits an event the pilot queries can find", async () => {
    const lines = await captureStdout(CLOUD_RUN, () =>
      logFeedback({ type: "feedback", timestamp: new Date().toISOString(), sessionId: "s", interactionId: "i", helpful: true, tags: ["too-slow"] })
    );
    assert.equal(JSON.parse(lines[0]).tags[0], "too-slow");
  });
});
