/**
 * Repeatable, traceable deploys and rollbacks for Hubi on Cloud Run.
 *
 *   node --experimental-strip-types scripts/deploy.ts <command> [--env pilot] [options]
 *
 *   plan                 read-only: preflight, checks, the exact command, current settings
 *   deploy --confirm <sha>   cut the deploy from the exact clean commit (see below)
 *   status               read-only: serving revision, traffic, recent revisions
 *   verify               read-only: confirm from Cloud Logging which commit is running
 *   rollback [--to <revision>] [--confirm <revision>]   shift all traffic to an older revision
 *
 * Rules this script enforces (docs/deployment-runbook.md):
 *   - A deploy is always an exact commit on an allowed branch with a clean tree,
 *     exported with `git archive`; never the working tree.
 *   - It never runs without `--confirm` typed with the exact commit it will ship.
 *   - Only the flags in config/environments/<env>.json are passed, and flags that
 *     would override sandbox-managed settings are rejected.
 *   - The service's protected settings (ingress, IAP, networking, service
 *     account, labels, environment variables, resources, scaling) are snapshotted
 *     before and compared after; any unexpected change is reported loudly with
 *     the rollback command.
 *   - Which commit serves is verifiable afterwards (build-info.json inlined into
 *     the bundle, a `startup` telemetry event, and `commit` on every log entry).
 *
 * Every command except `deploy --confirm` and `rollback --confirm` is read-only.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDeployArgs,
  buildInfoFile,
  confirmationMatches,
  diffProtected,
  expectedChanges,
  formatCommand,
  parseEnvironmentConfig,
  pickRollbackTarget,
  preflightProblems,
  rollbackArgs,
  snapshotFromDescribe,
  sortRevisions,
  type EnvironmentConfig,
  type ServiceSnapshot,
} from "./lib/deployLogic.ts";

const WINDOWS = process.platform === "win32";

/** cmd.exe does not quote for us when a shell is used: wrap arguments that contain spaces or quotes. */
function quoteForShell(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function run(cmd: string, args: string[], opts: { cwd?: string; inherit?: boolean } = {}) {
  const r = spawnSync(cmd, WINDOWS ? args.map(quoteForShell) : args, { encoding: "utf8", shell: WINDOWS, cwd: opts.cwd, stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return { command, opts };
}

function loadConfig(env: string): EnvironmentConfig {
  const file = path.join("config", "environments", `${env}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read ${file}: ${(err as Error).message}`);
  }
  const parsed = parseEnvironmentConfig(raw);
  if (!parsed.ok) fail(`${file} is invalid:\n  - ${parsed.errors.join("\n  - ")}`);
  return parsed.config;
}

function git(args: string[]): string {
  const r = run("git", args);
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function preflight() {
  const clean = git(["status", "--porcelain"]) === "";
  return { clean, branch: git(["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(["rev-parse", "HEAD"]) };
}

function describeService(config: EnvironmentConfig) {
  const r = run("gcloud", ["run", "services", "describe", config.service, "--region", config.region, "--project", config.project, "--format=json"]);
  if (r.status !== 0) fail(`gcloud describe failed (is gcloud authenticated for ${config.project}?):\n${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

function listRevisions(config: EnvironmentConfig) {
  const r = run("gcloud", ["run", "revisions", "list", "--service", config.service, "--region", config.region, "--project", config.project, "--format=json"]);
  if (r.status !== 0) fail(`gcloud revisions list failed:\n${r.stderr.trim()}`);
  return sortRevisions(JSON.parse(r.stdout));
}

function printSnapshot(s: ServiceSnapshot) {
  console.log(`  serving revision : ${s.latestReadyRevision}`);
  console.log(`  traffic          : ${s.traffic.map((t) => `${t.revisionName ?? (t.latestRevision ? "latest" : "?")}=${t.percent}%`).join(", ")}`);
  console.log(`  ingress / IAP    : ${s.ingress} / iap-enabled=${s.iapEnabled}`);
  console.log(`  service account  : ${s.serviceAccount}`);
  console.log(`  scaling          : min ${s.minScale}, max ${s.maxScale}, session affinity ${s.sessionAffinity}`);
  console.log(`  resources        : ${JSON.stringify(s.resources)}`);
  console.log(`  env variables    : ${Object.keys(s.env).join(", ")}`);
}

function runChecks() {
  console.log("\nChecks (type check, tests, production build)");
  for (const [label, cmd, args] of [
    ["tsc", "npx", ["tsc", "--noEmit"]],
    ["tests", "npm", ["test"]],
    ["build", "npm", ["run", "build"]],
  ] as const) {
    const r = run(cmd, [...args]);
    const tail = (r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | ").slice(0, 160);
    console.log(`  ${r.status === 0 ? "PASS" : "FAIL"} ${label}${r.status === 0 ? "" : `: ${tail}`}`);
    if (r.status !== 0) fail(`the ${label} check failed; nothing was deployed`);
  }
}

function plan(config: EnvironmentConfig, opts: Record<string, string | boolean>) {
  const pre = preflight();
  console.log(`Hubi deploy plan -- environment "${config.name}" (${config.project} / ${config.region} / ${config.service})`);
  console.log(`  commit : ${pre.commit}\n  branch : ${pre.branch}\n  tree   : ${pre.clean ? "clean" : "DIRTY"}`);
  const problems = preflightProblems(pre, config);
  for (const p of problems) console.log(`  ! ${p}`);
  console.log("\nCurrent service (read-only)");
  const before = snapshotFromDescribe(describeService(config));
  printSnapshot(before);
  if (!opts["skip-checks"] && problems.length === 0) runChecks();
  const exportDir = "<export of the exact commit>";
  console.log("\nCommand that `deploy` will run (only the flags that must change):");
  console.log("  " + formatCommand(buildDeployArgs(config, exportDir)));
  console.log(`\nExpected to change: the container image and a new revision. Nothing else. Protected settings are compared before and after.`);
  if (problems.length > 0) fail("preflight failed; fix the problems above before deploying");
  console.log(`\nTo deploy exactly this commit:\n  node --experimental-strip-types scripts/deploy.ts deploy --env ${config.name} --confirm ${pre.commit.slice(0, 7)}`);
  return { pre, before };
}

function exportCommit(commit: string, dir: string) {
  const tarFile = path.join(dir, "source.tar");
  const target = path.join(dir, "src");
  mkdirSync(target, { recursive: true });
  const a = run("git", ["archive", "--format=tar", "-o", tarFile, commit]);
  if (a.status !== 0) fail(`git archive failed: ${a.stderr.trim()}`);
  const t = run("tar", ["-xf", tarFile, "-C", target]);
  if (t.status !== 0) fail(`tar failed: ${t.stderr.trim()}`);
  rmSync(tarFile, { force: true });
  return target;
}

function deploy(config: EnvironmentConfig, opts: Record<string, string | boolean>) {
  const { pre, before } = plan(config, { ...opts, "skip-checks": opts["skip-checks"] });
  if (!confirmationMatches(typeof opts.confirm === "string" ? opts.confirm : undefined, pre.commit)) {
    fail(`--confirm must be the short commit being deployed (${pre.commit.slice(0, 7)}). Nothing was deployed.`);
  }

  const work = mkdtempSync(path.join(os.tmpdir(), "hubi-deploy-"));
  try {
    const source = exportCommit(pre.commit, work);
    writeFileSync(path.join(source, "build-info.json"), JSON.stringify(buildInfoFile(pre), null, 2));
    const args = buildDeployArgs(config, source);
    console.log(`\nDeploying ${pre.commit.slice(0, 7)}...\n  ${formatCommand(args)}\n`);
    const r = run("gcloud", args, { inherit: true });
    if (r.status !== 0) fail("gcloud run deploy failed. The previous revision is still serving; check the output above.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  console.log("\nAfter deploy (read-only)");
  const after = snapshotFromDescribe(describeService(config));
  printSnapshot(after);
  const diffs = diffProtected(before, after, expectedChanges(config.deployFlags));
  if (diffs.length === 0) console.log("\nProtected settings: unchanged.");
  else {
    console.log("\nALERT: protected settings changed during this deploy:");
    for (const d of diffs) console.log(`  - ${d.setting}: ${d.before} -> ${d.after}`);
  }

  mkdirSync("logs", { recursive: true });
  appendFileSync(
    path.join("logs", "deploy-ledger.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), env: config.name, commit: pre.commit, branch: pre.branch, previousRevision: before.latestReadyRevision, newRevision: after.latestReadyRevision, protectedChanges: diffs.length }) + "\n"
  );
  const previous = before.latestReadyRevision;
  console.log(`\nDeployed ${pre.commit.slice(0, 7)} as revision ${after.latestReadyRevision}.`);
  console.log(`Verify:   node --experimental-strip-types scripts/deploy.ts verify --env ${config.name}`);
  if (previous) console.log(`Rollback: node --experimental-strip-types scripts/deploy.ts rollback --env ${config.name} --to ${previous} --confirm ${previous}`);
  if (diffs.length > 0) process.exitCode = 2;
}

function status(config: EnvironmentConfig) {
  console.log(`Status -- ${config.service} (${config.project} / ${config.region})`);
  const snap = snapshotFromDescribe(describeService(config));
  printSnapshot(snap);
  console.log("\nRecent revisions (newest first)");
  for (const r of listRevisions(config).slice(0, 6)) console.log(`  ${r.name}  ${r.createdAt}${r.name === snap.latestReadyRevision ? "  <- serving" : ""}`);
}

function verify(config: EnvironmentConfig) {
  const head = git(["rev-parse", "HEAD"]);
  const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${config.service}" AND jsonPayload.component="hubi" AND jsonPayload.event="startup"`;
  const r = run("gcloud", ["logging", "read", filter, "--project", config.project, "--limit", "5", "--freshness", "1d", "--format=json"]);
  if (r.status !== 0) fail(`gcloud logging read failed:\n${r.stderr.trim()}`);
  const entries = JSON.parse(r.stdout || "[]");
  console.log(`Startup events for ${config.service} in the last day (newest first):`);
  if (entries.length === 0) console.log("  none found. Either the build predates this telemetry, the revision has not started, or the logging permission is missing.");
  for (const e of entries) {
    const p = e.jsonPayload ?? {};
    console.log(`  ${e.timestamp}  revision ${p.revision}  commit ${String(p.commit).slice(0, 7)}  verifier=${p.claimVerifierEnabled}  provider=${p.provider}`);
  }
  const newest = entries[0]?.jsonPayload;
  if (newest) console.log(newest.commit === head ? `\nOK: the newest revision runs the current commit (${head.slice(0, 7)}).` : `\nNote: the newest revision runs ${String(newest.commit).slice(0, 7)}, not the current HEAD ${head.slice(0, 7)}.`);
}

function rollback(config: EnvironmentConfig, opts: Record<string, string | boolean>) {
  const snap = snapshotFromDescribe(describeService(config));
  const revisions = listRevisions(config);
  const picked = pickRollbackTarget(revisions, snap.latestReadyRevision, typeof opts.to === "string" ? opts.to : undefined);
  if (!picked.ok) fail(picked.error);
  const args = rollbackArgs(config, picked.target);
  console.log(`Serving now : ${snap.latestReadyRevision}\nRoll back to: ${picked.target}\n  ${formatCommand(args)}`);
  if (opts.confirm !== picked.target) {
    console.log(`\nNothing changed. To execute, add: --to ${picked.target} --confirm ${picked.target}`);
    return;
  }
  const r = run("gcloud", args, { inherit: true });
  if (r.status !== 0) fail("update-traffic failed; traffic is unchanged.");
  const after = snapshotFromDescribe(describeService(config));
  console.log(`\nTraffic now: ${after.traffic.map((t) => `${t.revisionName}=${t.percent}%`).join(", ")}`);
  console.log(`Confirm what serves with: node --experimental-strip-types scripts/deploy.ts verify --env ${config.name}`);
}

const { command, opts } = parseArgs(process.argv.slice(2));
const config = loadConfig(typeof opts.env === "string" ? opts.env : "pilot");
switch (command) {
  case "plan":
    plan(config, opts);
    break;
  case "deploy":
    deploy(config, opts);
    break;
  case "status":
    status(config);
    break;
  case "verify":
    verify(config);
    break;
  case "rollback":
    rollback(config, opts);
    break;
  default:
    console.log("usage: scripts/deploy.ts <plan|deploy|status|verify|rollback> [--env pilot] [--confirm <sha|revision>] [--to <revision>] [--skip-checks]");
    process.exitCode = command ? 1 : 0;
}
