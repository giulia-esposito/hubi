import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  buildDeployArgs,
  buildInfoFile,
  confirmationMatches,
  diffProtected,
  expectedChanges,
  extractTarArgs,
  formatCommand,
  parseEnvironmentConfig,
  pickRollbackTarget,
  preflightProblems,
  rollbackArgs,
  snapshotFromDescribe,
  sortRevisions,
  validateDeployFlags,
  type EnvironmentConfig,
} from "../scripts/lib/deployLogic.ts";

// Offline: the safety rules of the deploy script, tested as pure functions. The
// script itself only adds I/O (git, gcloud) around them.

const CONFIG: EnvironmentConfig = {
  name: "pilot",
  project: "wh-revenue-sandbox",
  region: "us-central1",
  service: "hubi-pilot",
  deployFlags: ["--memory", "2Gi"],
  allowedBranches: ["main", "develop"],
};

/** Shaped like `gcloud run services describe --format=json` for the real service. */
function describeJson(overrides: { image?: string; memory?: string; ingress?: string; iap?: string; labels?: Record<string, string>; env?: { name: string; value: string }[]; revision?: string } = {}) {
  return {
    metadata: {
      annotations: { "run.googleapis.com/ingress": overrides.ingress ?? "internal", "run.googleapis.com/iap-enabled": overrides.iap ?? "true" },
      labels: overrides.labels ?? { "env": "sandbox", "owner": "revenue" },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/network-interfaces": '[{"network":"n","subnetwork":"s"}]',
            "run.googleapis.com/vpc-access-egress": "all-traffic",
            "autoscaling.knative.dev/minScale": "1",
            "autoscaling.knative.dev/maxScale": "20",
            "run.googleapis.com/sessionAffinity": "false",
            "run.googleapis.com/cpu-throttling": "true",
          },
        },
        spec: {
          serviceAccountName: "sandbox-run@wh-revenue-sandbox.iam.gserviceaccount.com",
          containers: [
            {
              image: overrides.image ?? "us-central1-docker.pkg.dev/p/r/hubi-pilot@sha256:aaa",
              env: overrides.env ?? [
                { name: "HUBI_REASONING_PROVIDER", value: "gemini" },
                { name: "GOOGLE_CLOUD_PROJECT", value: "wh-revenue-sandbox" },
              ],
              resources: { limits: { cpu: "1000m", memory: overrides.memory ?? "2Gi" } },
            },
          ],
        },
      },
    },
    status: {
      latestReadyRevisionName: overrides.revision ?? "hubi-pilot-00005-s6p",
      traffic: [{ revisionName: overrides.revision ?? "hubi-pilot-00005-s6p", percent: 100 }],
    },
  };
}

describe("deploy flags", () => {
  test("flags that would override sandbox-managed settings are rejected", () => {
    for (const flag of ["--set-env-vars=A=B", "--service-account=x", "--ingress=all", "--vpc-connector=c", "--network=n", "--update-labels=a=b", "--allow-unauthenticated", "--no-allow-unauthenticated", "--clear-labels", "--set-secrets=A=b:1"]) {
      assert.equal(validateDeployFlags([flag]).length, 1, flag);
    }
  });

  test("the flags a deploy needs are accepted", () => {
    assert.deepEqual(validateDeployFlags(["--memory", "2Gi", "--min-instances=1", "--cpu=1"]), []);
  });

  test("the committed pilot config is valid and passes its own safety rules", () => {
    const parsed = parseEnvironmentConfig(JSON.parse(readFileSync("config/environments/pilot.json", "utf8")));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
    assert.equal(parsed.config.service, "hubi-pilot");
    assert.deepEqual(validateDeployFlags(parsed.config.deployFlags), []);
  });
});

describe("parseEnvironmentConfig", () => {
  test("requires name, project, region and service", () => {
    const r = parseEnvironmentConfig({});
    assert.ok(!r.ok && r.errors.length >= 4);
  });

  test("rejects a config whose deploy flags are forbidden", () => {
    const r = parseEnvironmentConfig({ ...CONFIG, deployFlags: ["--set-env-vars=A=B"] });
    assert.ok(!r.ok);
  });

  test("defaults the allowed branches", () => {
    const r = parseEnvironmentConfig({ name: "n", project: "p", region: "r", service: "s" });
    assert.ok(r.ok && r.config.allowedBranches.includes("main"));
  });
});

describe("commands", () => {
  test("the deploy command is exactly source + region + project + the configured flags", () => {
    assert.deepEqual(buildDeployArgs(CONFIG, "/tmp/src"), ["run", "deploy", "hubi-pilot", "--source", "/tmp/src", "--region", "us-central1", "--project", "wh-revenue-sandbox", "--memory", "2Gi"]);
    assert.equal(formatCommand(buildDeployArgs(CONFIG, "/tmp/src")), "gcloud run deploy hubi-pilot --source /tmp/src --region us-central1 --project wh-revenue-sandbox --memory 2Gi");
  });

  test("paths with spaces are quoted in the printed command", () => {
    assert.match(formatCommand(["run", "deploy", "s", "--source", "C:\\Users\\A B\\src"]), /"C:\\Users\\A B\\src"/);
  });

  test("the rollback command moves 100% of traffic to the named revision", () => {
    assert.deepEqual(rollbackArgs(CONFIG, "hubi-pilot-00004-kbn"), ["run", "services", "update-traffic", "hubi-pilot", "--region", "us-central1", "--project", "wh-revenue-sandbox", "--to-revisions=hubi-pilot-00004-kbn=100"]);
  });
});

describe("protected settings: snapshot and diff", () => {
  const before = snapshotFromDescribe(describeJson());

  test("reads the settings we protect and what is serving", () => {
    assert.equal(before.ingress, "internal");
    assert.equal(before.iapEnabled, "true");
    assert.equal(before.serviceAccount, "sandbox-run@wh-revenue-sandbox.iam.gserviceaccount.com");
    assert.equal(before.minScale, "1");
    assert.equal(before.sessionAffinity, "false");
    assert.equal(before.env.HUBI_REASONING_PROVIDER, "gemini");
    assert.equal(before.resources.memory, "2Gi");
    assert.equal(before.latestReadyRevision, "hubi-pilot-00005-s6p");
    assert.deepEqual(before.traffic, [{ revisionName: "hubi-pilot-00005-s6p", percent: 100, latestRevision: undefined }]);
  });

  test("a new image and a new revision are not a protected change", () => {
    const after = snapshotFromDescribe(describeJson({ image: "us-central1-docker.pkg.dev/p/r/hubi-pilot@sha256:bbb", revision: "hubi-pilot-00006-abc" }));
    assert.deepEqual(diffProtected(before, after), []);
  });

  test("changed ingress, IAP, labels and a removed environment variable are all named", () => {
    const after = snapshotFromDescribe(
      describeJson({ ingress: "all", iap: "false", labels: { env: "sandbox" }, env: [{ name: "HUBI_REASONING_PROVIDER", value: "gemini" }] })
    );
    const settings = diffProtected(before, after).map((d) => d.setting).sort();
    assert.deepEqual(settings, ["env.GOOGLE_CLOUD_PROJECT", "iapEnabled", "ingress", "labels"]);
  });

  test("a changed environment variable value is caught", () => {
    const after = snapshotFromDescribe(
      describeJson({ env: [{ name: "HUBI_REASONING_PROVIDER", value: "claude-code" }, { name: "GOOGLE_CLOUD_PROJECT", value: "wh-revenue-sandbox" }] })
    );
    assert.deepEqual(diffProtected(before, after).map((d) => d.setting), ["env.HUBI_REASONING_PROVIDER"]);
  });

  test("a change the deploy flags asked for is allowed; an unrequested one is not", () => {
    const after = snapshotFromDescribe(describeJson({ memory: "4Gi" }));
    assert.deepEqual(diffProtected(before, after, expectedChanges(["--memory", "4Gi"])), []);
    assert.deepEqual(diffProtected(before, after, expectedChanges([])).map((d) => d.setting), ["resources.memory"]);
  });

  test("expectedChanges maps scaling and resource flags to the settings they move", () => {
    assert.deepEqual(expectedChanges(["--min-instances=2", "--max-instances=5", "--cpu=2"]).sort(), ["maxScale", "minScale", "resources.cpu"]);
  });
});

describe("confirmation", () => {
  const commit = "6cd1a52f0e9d8b7a6c5d4e3f2a1b0c9d8e7f6a5b";

  test("a deploy needs the exact short commit", () => {
    assert.equal(confirmationMatches("6cd1a52", commit), true);
    assert.equal(confirmationMatches("6CD1A52", commit), true);
    assert.equal(confirmationMatches(commit, commit), true);
  });

  test("anything else is refused", () => {
    for (const bad of [undefined, "", "yes", "6cd1a5", "deadbeef", "6cd1a53"]) assert.equal(confirmationMatches(bad, commit), false, String(bad));
  });
});

describe("rollback target", () => {
  const revisions = sortRevisions([
    { metadata: { name: "hubi-pilot-00004-kbn", creationTimestamp: "2026-10-10T10:00:00Z" } },
    { metadata: { name: "hubi-pilot-00006-abc", creationTimestamp: "2026-10-29T10:00:00Z" } },
    { metadata: { name: "hubi-pilot-00005-s6p", creationTimestamp: "2026-10-16T10:00:00Z" } },
  ]);

  test("revisions are ordered newest first", () => {
    assert.deepEqual(revisions.map((r) => r.name), ["hubi-pilot-00006-abc", "hubi-pilot-00005-s6p", "hubi-pilot-00004-kbn"]);
  });

  test("by default the target is the newest revision older than the one serving", () => {
    assert.deepEqual(pickRollbackTarget(revisions, "hubi-pilot-00006-abc"), { ok: true, target: "hubi-pilot-00005-s6p" });
    assert.deepEqual(pickRollbackTarget(revisions, "hubi-pilot-00005-s6p"), { ok: true, target: "hubi-pilot-00004-kbn" });
  });

  test("an explicit target must exist and must not be the one already serving", () => {
    assert.deepEqual(pickRollbackTarget(revisions, "hubi-pilot-00006-abc", "hubi-pilot-00004-kbn"), { ok: true, target: "hubi-pilot-00004-kbn" });
    assert.equal(pickRollbackTarget(revisions, "hubi-pilot-00006-abc", "nope").ok, false);
    assert.equal(pickRollbackTarget(revisions, "hubi-pilot-00006-abc", "hubi-pilot-00006-abc").ok, false);
  });

  test("with nothing older there is nothing to roll back to", () => {
    assert.equal(pickRollbackTarget(revisions, "hubi-pilot-00004-kbn").ok, false);
  });
});

describe("preflight", () => {
  const good = { clean: true, branch: "develop", commit: "6cd1a52f0e9d8b7a6c5d4e3f2a1b0c9d8e7f6a5b" };

  test("a clean tree on an allowed branch passes", () => {
    assert.deepEqual(preflightProblems(good, CONFIG), []);
  });

  test("a dirty tree, a disallowed branch or an unreadable commit each block a deploy", () => {
    assert.equal(preflightProblems({ ...good, clean: false }, CONFIG).length, 1);
    assert.equal(preflightProblems({ ...good, branch: "feature/x" }, CONFIG).length, 1);
    assert.equal(preflightProblems({ ...good, commit: "" }, CONFIG).length, 1);
  });

  test("build-info records the exact commit, branch and time", () => {
    const info = buildInfoFile(good, new Date("2026-10-29T12:00:00Z"));
    assert.deepEqual(info, { commit: good.commit, branch: "develop", builtAt: "2026-10-29T12:00:00.000Z" });
  });
});

describe("extracting the exported commit", () => {
  test("uses relative names only, so a Windows drive letter is never passed to tar", () => {
    const args = extractTarArgs();
    assert.deepEqual(args, ["-xf", "source.tar", "-C", "src"]);
    assert.ok(args.every((a) => !/^[A-Za-z]:|[\/]/.test(a)), "no drive letter, no path separators");
  });

  test("really extracts with the system tar when run from the export folder", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hubi-tar-test-"));
    try {
      mkdirSync(path.join(dir, "payload"));
      writeFileSync(path.join(dir, "payload", "hello.txt"), "hi");
      // Build the archive the way the script receives it (inside the folder, relative names), then extract it with the real arguments.
      const make = spawnSync("tar", ["-cf", "source.tar", "-C", "payload", "hello.txt"], { cwd: dir, encoding: "utf8" });
      assert.equal(make.status, 0, make.stderr);
      mkdirSync(path.join(dir, "src"));
      const extract = spawnSync("tar", extractTarArgs(), { cwd: dir, encoding: "utf8" });
      assert.equal(extract.status, 0, extract.stderr);
      assert.ok(existsSync(path.join(dir, "src", "hello.txt")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe(".gcloudignore", () => {
  const lines = readFileSync(".gcloudignore", "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  test("does not exclude build-info.json: gcloud would otherwise drop the file the deploy script writes, and every startup event says unknown", () => {
    assert.ok(!lines.some((l) => /build-info/.test(l)));
    // The reason the file is needed at all: without a .gcloudignore, gcloud falls back to .gitignore, which excludes it.
    assert.ok(readFileSync(".gitignore", "utf8").split("\n").some((l) => l.trim() === "build-info.json"));
  });

  test("still keeps secrets, dependencies, build output, logs and the content repository out of the upload", () => {
    for (const must of [".env", ".env.*", "node_modules", ".next", "logs", "Content Repository", ".git"]) assert.ok(lines.includes(must), must);
  });
});
