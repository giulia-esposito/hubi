/**
 * Pure logic behind scripts/deploy.ts: no I/O, so every rule that keeps a
 * deploy safe is unit-tested (tests/deploy.test.ts).
 *
 * The deployment model (see docs/deployment-runbook.md): GitHub is canonical;
 * a deploy is always an exact, clean commit exported with `git archive`; only
 * the flags that must change are passed to `gcloud run deploy`; sandbox-managed
 * settings (ingress, IAP, networking, service account, labels, existing
 * environment variables) are never touched, and a before/after diff of them is
 * checked after every deploy.
 */

export interface EnvironmentConfig {
  /** Environment name, e.g. "pilot". */
  name: string;
  project: string;
  region: string;
  service: string;
  /** Extra `gcloud run deploy` flags: only those that must change. */
  deployFlags: string[];
  /** Branches a deploy may be cut from. */
  allowedBranches: string[];
}

/** Flags that would override sandbox-managed or security-relevant configuration. */
const FORBIDDEN_FLAG_PREFIXES = [
  "--set-env-vars",
  "--clear-env-vars",
  "--remove-env-vars",
  "--set-secrets",
  "--service-account",
  "--ingress",
  "--vpc",
  "--network",
  "--subnet",
  "--labels",
  "--update-labels",
  "--remove-labels",
  "--clear-labels",
  "--allow-unauthenticated",
  "--no-allow-unauthenticated",
  "--iap",
  "--no-iap",
  "--binary-authorization",
  "--clear-vpc",
  "--clear-network",
];

export function validateDeployFlags(flags: string[]): string[] {
  const problems: string[] = [];
  for (const flag of flags) {
    const name = flag.split("=")[0];
    if (FORBIDDEN_FLAG_PREFIXES.some((p) => name === p || name.startsWith(p + "-"))) {
      problems.push(`"${name}" would override sandbox-managed or security configuration and must not be passed by the deploy script`);
    }
  }
  return problems;
}

export function parseEnvironmentConfig(raw: unknown): { ok: true; config: EnvironmentConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof o[k] !== "string" || !String(o[k]).trim()) errors.push(`"${k}" is required`);
    return String(o[k] ?? "").trim();
  };
  const name = str("name");
  const project = str("project");
  const region = str("region");
  const service = str("service");
  const deployFlags = Array.isArray(o.deployFlags) && o.deployFlags.every((f) => typeof f === "string") ? (o.deployFlags as string[]) : [];
  if (o.deployFlags !== undefined && !Array.isArray(o.deployFlags)) errors.push(`"deployFlags" must be an array of strings`);
  const allowedBranches = Array.isArray(o.allowedBranches) && o.allowedBranches.length > 0 ? (o.allowedBranches as string[]) : ["main", "develop"];
  errors.push(...validateDeployFlags(deployFlags));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: { name, project, region, service, deployFlags, allowedBranches } };
}

/** The exact `gcloud` arguments for a deploy of an exported commit. */
export function buildDeployArgs(config: EnvironmentConfig, sourceDir: string): string[] {
  return ["run", "deploy", config.service, "--source", sourceDir, "--region", config.region, "--project", config.project, ...config.deployFlags];
}

export function formatCommand(args: string[]): string {
  return "gcloud " + args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

export interface ServiceSnapshot {
  ingress: string | null;
  iapEnabled: string | null;
  networkInterfaces: string | null;
  vpcEgress: string | null;
  serviceAccount: string | null;
  labels: Record<string, string>;
  env: Record<string, string>;
  resources: Record<string, string>;
  minScale: string | null;
  maxScale: string | null;
  sessionAffinity: string | null;
  cpuThrottling: string | null;
  /** Not protected: expected to change on a deploy. */
  image: string | null;
  latestReadyRevision: string | null;
  traffic: { revisionName?: string; percent?: number; latestRevision?: boolean }[];
}

type Json = Record<string, any>;

/** Extracts the settings we protect, and the identity of what is serving, from `gcloud run services describe --format=json`. */
export function snapshotFromDescribe(describe: Json): ServiceSnapshot {
  const meta = describe.metadata ?? {};
  const ann = meta.annotations ?? {};
  const tmplAnn = describe.spec?.template?.metadata?.annotations ?? {};
  const container = describe.spec?.template?.spec?.containers?.[0] ?? {};
  const env: Record<string, string> = {};
  for (const e of container.env ?? []) env[String(e.name)] = String(e.value ?? (e.valueFrom ? "[secret reference]" : ""));
  const resources: Record<string, string> = {};
  for (const [k, v] of Object.entries(container.resources?.limits ?? {})) resources[k] = String(v);
  return {
    ingress: ann["run.googleapis.com/ingress"] ?? null,
    iapEnabled: ann["run.googleapis.com/iap-enabled"] ?? null,
    networkInterfaces: tmplAnn["run.googleapis.com/network-interfaces"] ?? null,
    vpcEgress: tmplAnn["run.googleapis.com/vpc-access-egress"] ?? null,
    serviceAccount: describe.spec?.template?.spec?.serviceAccountName ?? null,
    labels: { ...(meta.labels ?? {}) },
    env,
    resources,
    minScale: tmplAnn["autoscaling.knative.dev/minScale"] ?? null,
    maxScale: tmplAnn["autoscaling.knative.dev/maxScale"] ?? null,
    sessionAffinity: tmplAnn["run.googleapis.com/sessionAffinity"] ?? null,
    cpuThrottling: tmplAnn["run.googleapis.com/cpu-throttling"] ?? null,
    image: container.image ?? null,
    latestReadyRevision: describe.status?.latestReadyRevisionName ?? null,
    traffic: (describe.status?.traffic ?? []).map((t: Json) => ({ revisionName: t.revisionName, percent: t.percent, latestRevision: t.latestRevision })),
  };
}

export interface Difference {
  setting: string;
  before: string;
  after: string;
}

const scalar = (v: unknown) => (v === null || v === undefined ? "(unset)" : String(v));

/**
 * Differences in protected settings. `allowed` lists settings this deploy is
 * expected to change (for example "resources.memory" when --memory is passed);
 * anything else that moved is a problem to report loudly.
 */
export function diffProtected(before: ServiceSnapshot, after: ServiceSnapshot, allowed: string[] = []): Difference[] {
  const diffs: Difference[] = [];
  const check = (setting: string, b: unknown, a: unknown) => {
    if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null) && !allowed.includes(setting)) {
      diffs.push({ setting, before: typeof b === "object" ? JSON.stringify(b) : scalar(b), after: typeof a === "object" ? JSON.stringify(a) : scalar(a) });
    }
  };
  check("ingress", before.ingress, after.ingress);
  check("iapEnabled", before.iapEnabled, after.iapEnabled);
  check("networkInterfaces", before.networkInterfaces, after.networkInterfaces);
  check("vpcEgress", before.vpcEgress, after.vpcEgress);
  check("serviceAccount", before.serviceAccount, after.serviceAccount);
  check("labels", before.labels, after.labels);
  check("minScale", before.minScale, after.minScale);
  check("maxScale", before.maxScale, after.maxScale);
  check("sessionAffinity", before.sessionAffinity, after.sessionAffinity);
  check("cpuThrottling", before.cpuThrottling, after.cpuThrottling);
  // Per-key so a single changed or removed variable is named.
  for (const key of new Set([...Object.keys(before.env), ...Object.keys(after.env)])) check(`env.${key}`, before.env[key], after.env[key]);
  for (const key of new Set([...Object.keys(before.resources), ...Object.keys(after.resources)])) check(`resources.${key}`, before.resources[key], after.resources[key]);
  return diffs;
}

/** Settings a deploy's own flags are expected to change, derived from those flags. */
export function expectedChanges(flags: string[]): string[] {
  const allowed: string[] = [];
  for (const flag of flags) {
    const name = flag.split("=")[0];
    if (name === "--memory") allowed.push("resources.memory");
    if (name === "--cpu") allowed.push("resources.cpu");
    if (name === "--min-instances") allowed.push("minScale");
    if (name === "--max-instances") allowed.push("maxScale");
    if (name === "--session-affinity" || name === "--no-session-affinity") allowed.push("sessionAffinity");
    if (name === "--cpu-throttling" || name === "--no-cpu-throttling") allowed.push("cpuThrottling");
  }
  return allowed;
}

/** A deploy proceeds only when the caller typed the exact short commit being deployed. */
export function confirmationMatches(confirm: string | undefined, commit: string): boolean {
  if (!confirm) return false;
  const c = confirm.trim().toLowerCase();
  return c.length >= 7 && commit.toLowerCase().startsWith(c);
}

export interface RevisionInfo {
  name: string;
  createdAt: string;
}

/** Revisions newest first, from `gcloud run revisions list --format=json`. */
export function sortRevisions(raw: Json[]): RevisionInfo[] {
  return raw
    .map((r) => ({ name: String(r.metadata?.name ?? ""), createdAt: String(r.metadata?.creationTimestamp ?? "") }))
    .filter((r) => r.name)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The rollback target: the one explicitly requested, otherwise the newest
 * revision older than the one currently serving. Refuses to "roll back" onto
 * the revision that is already serving.
 */
export function pickRollbackTarget(
  revisions: RevisionInfo[],
  serving: string | null,
  requested?: string
): { ok: true; target: string } | { ok: false; error: string } {
  if (requested) {
    if (!revisions.some((r) => r.name === requested)) return { ok: false, error: `revision "${requested}" does not exist` };
    if (requested === serving) return { ok: false, error: `revision "${requested}" is already serving all traffic` };
    return { ok: true, target: requested };
  }
  const idx = serving ? revisions.findIndex((r) => r.name === serving) : -1;
  const older = idx >= 0 ? revisions.slice(idx + 1) : revisions.slice(1);
  if (older.length === 0) return { ok: false, error: "there is no older revision to roll back to" };
  return { ok: true, target: older[0].name };
}

export function rollbackArgs(config: EnvironmentConfig, revision: string): string[] {
  return ["run", "services", "update-traffic", config.service, "--region", config.region, "--project", config.project, `--to-revisions=${revision}=100`];
}

export interface Preflight {
  clean: boolean;
  branch: string;
  commit: string;
}

/** Why a deploy cannot be cut from this tree, if it cannot. */
export function preflightProblems(pre: Preflight, config: EnvironmentConfig): string[] {
  const problems: string[] = [];
  if (!pre.clean) problems.push("the working tree has uncommitted changes: a deploy must be an exact commit");
  if (!config.allowedBranches.includes(pre.branch)) problems.push(`branch "${pre.branch}" is not one of ${config.allowedBranches.join(", ")}`);
  if (!/^[0-9a-f]{7,40}$/i.test(pre.commit)) problems.push("could not read the current commit");
  return problems;
}

export interface BuildInfoFile {
  commit: string;
  branch: string;
  builtAt: string;
}

export function buildInfoFile(pre: Preflight, now: Date = new Date()): BuildInfoFile {
  return { commit: pre.commit, branch: pre.branch, builtAt: now.toISOString() };
}
