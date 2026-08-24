#!/usr/bin/env node
/**
 * Hubi — Phase 0 Reasoning Engine Validation
 *
 * Validates that Claude Code can be invoked programmatically, non-interactively,
 * with no tools/MCP/project-context leakage, and determines whether real token
 * streaming is reliable enough to use, or whether Hubi should fall back to a
 * progressive-reveal rendering of a complete response.
 *
 * Zero npm dependencies on purpose — run this before `npm install` even exists
 * in this project. Requires: Node 18+, and `claude` (Claude Code CLI) installed
 * and logged into your account on THIS machine.
 *
 * Usage:  node scripts/validate-phase0.mjs
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = path.join(__dirname, "phase0-result.json");

const report = {
  ranAt: new Date().toISOString(),
  checks: {},
  overall: "unknown",
  reasoningEngineMode: null,
  notes: [],
};

function log(msg) {
  console.log(msg);
}

function runClaude(args, { timeoutMs = 30000 } = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - start });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err), timedOut: false, durationMs: Date.now() - start });
    });
  });
}

function parseNdjson(stdout) {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { unparsed: l };
      }
    });
}

const ISOLATION_ARGS = ["--tools", "", "--strict-mcp-config", "--setting-sources", ""];
const SYSTEM_PROMPT =
  "You are a headless reasoning engine invoked by an internal tool called Hubi. " +
  "Follow the user's instruction exactly and output nothing else.";

async function checkAuth() {
  const res = await runClaude(["auth", "status"], { timeoutMs: 15000 });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* not json, ignore */
  }
  const loggedIn = parsed?.loggedIn === true;
  report.checks.auth = { loggedIn, raw: parsed ?? res.stdout.trim(), stderr: res.stderr.trim() };
  return loggedIn;
}

async function checkMinimalInvocation() {
  const args = [
    "-p",
    "Reply with exactly this text and nothing else: HUBI_PHASE0_OK",
    "--output-format",
    "json",
    "--system-prompt",
    SYSTEM_PROMPT,
    ...ISOLATION_ARGS,
  ];
  const res = await runClaude(args, { timeoutMs: 45000 });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* ignore */
  }
  const success = parsed?.subtype === "success" && String(parsed?.result ?? "").includes("HUBI_PHASE0_OK");
  report.checks.minimalInvocation = {
    pass: success,
    durationMs: res.durationMs,
    subtype: parsed?.subtype,
    isError: parsed?.is_error,
    resultText: parsed?.result,
    stderr: res.stderr.trim(),
  };
  return success;
}

async function checkStreamingAndIsolation() {
  const args = [
    "-p",
    "Count from one to five, one number per short sentence.",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--system-prompt",
    SYSTEM_PROMPT,
    ...ISOLATION_ARGS,
  ];
  const res = await runClaude(args, { timeoutMs: 45000 });
  const events = parseNdjson(res.stdout);

  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const toolsEmpty = Array.isArray(init?.tools) && init.tools.length === 0;
  const mcpEmpty = Array.isArray(init?.mcp_servers) && init.mcp_servers.length === 0;

  const chunkEvents = events.filter((e) => e.type === "assistant" || e.type === "stream_event");
  // The real CLI schema nests the incremental delta one level deeper, under .event.delta.text
  // (a top-level stream_event envelope wraps the actual Anthropic streaming event) -- reading
  // only a top-level .delta.text silently returns null for every stream_event and produces a
  // false "no streaming" result.
  const textSnapshots = new Set(
    chunkEvents
      .map((e) => e?.message?.content?.[0]?.text ?? e?.event?.delta?.text ?? null)
      .filter(Boolean)
  );
  const resultEvent = events.find((e) => e.type === "result");

  const realStreamingObserved = chunkEvents.length > 1 && textSnapshots.size > 1;

  report.checks.streamingAndIsolation = {
    toolsEmpty,
    mcpEmpty,
    initToolsSeen: init?.tools ?? null,
    initMcpServersSeen: init?.mcp_servers ?? null,
    totalEvents: events.length,
    chunkEventCount: chunkEvents.length,
    distinctTextSnapshots: textSnapshots.size,
    realStreamingObserved,
    resultSuccess: resultEvent?.subtype === "success",
    durationMs: res.durationMs,
    stderr: res.stderr.trim(),
  };
  return { toolsEmpty, mcpEmpty, realStreamingObserved };
}

async function checkNoFileAccess() {
  const args = [
    "-p",
    "Can you list files in the current directory, read any file, or use any tool right now? Answer with only YES or NO, then a 5-word reason.",
    "--output-format",
    "json",
    "--system-prompt",
    SYSTEM_PROMPT,
    ...ISOLATION_ARGS,
  ];
  const res = await runClaude(args, { timeoutMs: 30000 });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* ignore */
  }
  const answersNo = /^no\b/i.test(String(parsed?.result ?? "").trim());
  report.checks.noFileAccess = { pass: answersNo, resultText: parsed?.result, stderr: res.stderr.trim() };
  return answersNo;
}

async function checkLatency() {
  const sampleKnowledge = "Sample retrieved knowledge chunk. ".repeat(120); // ~ realistic grounded-prompt size
  const prompts = [
    "In one sentence, what is Hubi?",
    `Given this context, summarize it in one sentence:\n\n${sampleKnowledge}`,
  ];
  const timings = [];
  for (const p of prompts) {
    const res = await runClaude(
      ["-p", p, "--output-format", "json", "--system-prompt", SYSTEM_PROMPT, ...ISOLATION_ARGS],
      { timeoutMs: 45000 }
    );
    timings.push(res.durationMs);
  }
  report.checks.latency = { samples: timings, unit: "ms" };
  return timings;
}

async function checkMultiTurnViaExplicitContext() {
  const turn1 = await runClaude(
    [
      "-p",
      "Remember this for later: the secret code is 4271. Reply with exactly: NOTED",
      "--output-format",
      "json",
      "--system-prompt",
      SYSTEM_PROMPT,
      ...ISOLATION_ARGS,
    ],
    { timeoutMs: 30000 }
  );
  let parsed1 = null;
  try {
    parsed1 = JSON.parse(turn1.stdout);
  } catch {
    /* ignore */
  }

  const followUpPrompt =
    `Conversation so far:\nUser: Remember this for later: the secret code is 4271. Reply with exactly: NOTED\n` +
    `Assistant: ${parsed1?.result ?? "NOTED"}\n\n` +
    `User: What was the secret code I told you? Reply with only the number.`;

  const turn2 = await runClaude(
    ["-p", followUpPrompt, "--output-format", "json", "--system-prompt", SYSTEM_PROMPT, ...ISOLATION_ARGS],
    { timeoutMs: 30000 }
  );
  let parsed2 = null;
  try {
    parsed2 = JSON.parse(turn2.stdout);
  } catch {
    /* ignore */
  }
  const rememberedCorrectly = String(parsed2?.result ?? "").includes("4271");
  report.checks.multiTurnViaExplicitContext = {
    pass: rememberedCorrectly,
    turn2ResultText: parsed2?.result,
  };
  return rememberedCorrectly;
}

async function checkErrorAndTimeoutHandling() {
  // 1) invalid model should fail cleanly, not hang
  const badModel = await runClaude(
    ["-p", "hello", "--model", "not-a-real-model-xyz", "--output-format", "json", ...ISOLATION_ARGS],
    { timeoutMs: 20000 }
  );
  let parsedBad = null;
  try {
    parsedBad = JSON.parse(badModel.stdout);
  } catch {
    /* ignore */
  }
  const cleanErrorOnBadModel = badModel.code !== 0 || parsedBad?.is_error === true;

  // 2) artificial short timeout should be caught by our own wrapper, not hang the process
  const forcedTimeout = await runClaude(
    ["-p", "Write a very long, detailed 2000 word essay about enterprise SaaS sales.", "--output-format", "json", ...ISOLATION_ARGS],
    { timeoutMs: 1500 }
  );

  report.checks.errorAndTimeoutHandling = {
    cleanErrorOnBadModel,
    badModelExitCode: badModel.code,
    badModelIsError: parsedBad?.is_error ?? null,
    timeoutWasCaught: forcedTimeout.timedOut === true,
  };
  return cleanErrorOnBadModel && forcedTimeout.timedOut === true;
}

async function main() {
  log("Hubi — Phase 0 Reasoning Engine Validation\n");

  log("1/7 Checking Claude Code authentication...");
  const loggedIn = await checkAuth();
  if (!loggedIn) {
    report.overall = "BLOCKED - not authenticated";
    report.notes.push("`claude auth status` did not report loggedIn:true. Run `claude /login` (or your org's setup-token flow) on this machine, then re-run this script.");
    writeFileSync(RESULT_PATH, JSON.stringify(report, null, 2));
    log("\n❌ Not logged in. Fix authentication and re-run. See phase0-result.json for details.");
    process.exit(1);
  }
  log("   ✓ logged in");

  log("2/7 Minimal non-interactive invocation...");
  const minimalOk = await checkMinimalInvocation();
  log(minimalOk ? "   ✓ pass" : "   ✗ FAIL — see phase0-result.json");

  log("3/7 Streaming behavior + tool/MCP isolation...");
  const { toolsEmpty, mcpEmpty, realStreamingObserved } = await checkStreamingAndIsolation();
  log(`   tools disabled: ${toolsEmpty ? "yes" : "NO"}, mcp disabled: ${mcpEmpty ? "yes" : "NO"}`);
  log(`   real incremental streaming observed: ${realStreamingObserved ? "YES" : "no (will need fallback)"}`);

  log("4/7 Confirming Claude reports no file/tool access...");
  const noAccessOk = await checkNoFileAccess();
  log(noAccessOk ? "   ✓ pass" : "   ✗ FAIL — Claude did not clearly say it has no access, check manually");

  log("5/7 Measuring representative latency...");
  const timings = await checkLatency();
  log(`   samples (ms): ${timings.join(", ")}`);

  log("6/7 Multi-turn continuity via explicit re-sent context (not CLI session resume)...");
  const multiTurnOk = await checkMultiTurnViaExplicitContext();
  log(multiTurnOk ? "   ✓ pass" : "   ✗ FAIL — see phase0-result.json");

  log("7/7 Error and timeout handling...");
  const errorHandlingOk = await checkErrorAndTimeoutHandling();
  log(errorHandlingOk ? "   ✓ pass" : "   ✗ FAIL — see phase0-result.json");

  const allCoreChecksPassed = minimalOk && toolsEmpty && mcpEmpty && noAccessOk && multiTurnOk && errorHandlingOk;
  report.overall = allCoreChecksPassed ? "PASS" : "PASS WITH ISSUES — review phase0-result.json";
  report.reasoningEngineMode = realStreamingObserved ? "stream" : "progressive-reveal-fallback";

  writeFileSync(RESULT_PATH, JSON.stringify(report, null, 2));

  log("\n──────────────────────────────────────────");
  log(`Overall: ${report.overall}`);
  log(`Recommended Reasoning Engine mode: ${report.reasoningEngineMode}`);
  log(`Full report written to: ${RESULT_PATH}`);
  log("Please share this file/output so the decision can be recorded in Prototype_Plan.md.");
}

main();
