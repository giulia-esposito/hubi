import type { Chunk } from "../ingestion/chunk.ts";
import { getRegionVocabulary, parseRegionMetadata, type RegionVocabulary } from "../applicability/regions.ts";
import { decideEntry, isRegistryId, type RegistryEntry, type RegistrySnapshot } from "./registry.ts";
import { REGISTRY_SNAPSHOT } from "./registrySnapshot.ts";

/**
 * The governance gate: registry in, annotated and filtered chunks out. It is
 * applied before the retrieval index is built, so a document that is out never
 * reaches retrieval, prompts, citations or logs (Finding #002 product decision:
 * AI Eligibility is a gate, not a retrieval optimization).
 *
 * Three kinds of document, three outcomes:
 *
 *   in the registry            the registry decides (AI Eligibility, Content
 *                              Status). Restricted documents stay, carrying the
 *                              registry's caveat to the prompt and the citation.
 *   registry-format ID, but    excluded. A document that claims an RKC identifier
 *   not in the registry        the registry does not know has not been assessed.
 *   no registry identifier     kept for the pilot and reported as unregistered:
 *                              these files (playbooks, the slide library) carry no
 *                              governance record at all. Whether they stay is a
 *                              Product decision, recorded in `unregistered` below.
 *
 * Nothing here names a document: the rule reads the registry, so a change in
 * eligibility is a registry export and a reviewed snapshot diff, not a code edit.
 */

export interface GovernancePolicy {
  /** What to do with a document that has no registry identifier at all. */
  unregistered: "allow" | "exclude";
  /** What to do with a registry-format identifier the registry does not list. */
  unknownRegistryId: "allow" | "exclude";
}

/** Pilot policy: unregistered files stay (excluding them would remove the golden pitch and playbooks), unknown RKC identifiers do not. */
export const PILOT_GOVERNANCE_POLICY: GovernancePolicy = { unregistered: "allow", unknownRegistryId: "exclude" };

export interface ExcludedContent {
  contentId: string;
  aiEligibility: string;
  chunkCount: number;
  /** Why the document is out, in the registry's terms. */
  reason: string;
}

export interface RestrictedContent {
  contentId: string;
  restriction: string;
  chunkCount: number;
}

export interface UnregisteredContent {
  documentId: string;
  title: string;
  chunkCount: number;
}

export interface RegistryDrift {
  contentId: string;
  field: "region";
  registry: string;
  document: string;
}

export interface GovernanceReport {
  registry: { source: string; sourceRevision: string; syncedAt: string; entries: number };
  chunksIn: number;
  chunksKept: number;
  excluded: ExcludedContent[];
  restricted: RestrictedContent[];
  unregistered: UnregisteredContent[];
  /** Registry fields that disagree with the document's own metadata. Reported, never auto-resolved. */
  drift: RegistryDrift[];
}

export interface GovernanceResult {
  chunks: Chunk[];
  excluded: ExcludedContent[];
  report: GovernanceReport;
}

function describeRegions(vocabulary: RegionVocabulary, raw: string): string | null {
  const parsed = parseRegionMetadata(vocabulary, raw);
  if (parsed.unrecognized.length > 0 || parsed.scope === "unspecified") return null;
  return [...parsed.regions].sort().join(", ");
}

export function applyGovernance(
  chunks: Chunk[],
  options: { registry?: RegistrySnapshot; policy?: GovernancePolicy; vocabulary?: RegionVocabulary } = {}
): GovernanceResult {
  const registry = options.registry ?? REGISTRY_SNAPSHOT;
  const policy = options.policy ?? PILOT_GOVERNANCE_POLICY;
  const vocabulary = options.vocabulary ?? getRegionVocabulary();
  const byId = new Map<string, RegistryEntry>(registry.entries.map((e) => [e.contentId, e]));

  const kept: Chunk[] = [];
  const excludedCounts = new Map<string, ExcludedContent>();
  const restrictedCounts = new Map<string, RestrictedContent>();
  const unregisteredCounts = new Map<string, UnregisteredContent>();
  const driftSeen = new Set<string>();
  const drift: RegistryDrift[] = [];

  const exclude = (chunk: Chunk, aiEligibility: string, reason: string) => {
    const existing = excludedCounts.get(chunk.documentId);
    if (existing) existing.chunkCount++;
    else excludedCounts.set(chunk.documentId, { contentId: chunk.documentId, aiEligibility, chunkCount: 1, reason });
  };

  for (const chunk of chunks) {
    const entry = byId.get(chunk.documentId);

    if (entry) {
      const decision = decideEntry(entry);
      if (!decision.allowed) {
        exclude(chunk, entry.aiEligibility, decision.reason);
        continue;
      }
      kept.push({
        ...chunk,
        governance: { status: "registered", aiEligibility: entry.aiEligibility, restriction: entry.restriction, risks: entry.risks.length ? entry.risks : undefined },
      });
      if (entry.restriction) {
        const r = restrictedCounts.get(entry.contentId);
        if (r) r.chunkCount++;
        else restrictedCounts.set(entry.contentId, { contentId: entry.contentId, restriction: entry.restriction, chunkCount: 1 });
      }
      if (!driftSeen.has(entry.contentId)) {
        driftSeen.add(entry.contentId);
        const registryRegions = describeRegions(vocabulary, entry.region);
        const documentRegions = chunk.regionRaw ? describeRegions(vocabulary, chunk.regionRaw) : null;
        if (registryRegions && documentRegions && registryRegions !== documentRegions) {
          drift.push({ contentId: entry.contentId, field: "region", registry: entry.region, document: chunk.regionRaw ?? "" });
        }
      }
      continue;
    }

    if (isRegistryId(chunk.documentId)) {
      if (policy.unknownRegistryId === "exclude") {
        exclude(chunk, "Not in registry", "carries a registry identifier the Content Registry does not list");
        continue;
      }
    } else if (policy.unregistered === "exclude") {
      exclude(chunk, "Unregistered", "has no registry identifier");
      continue;
    }

    const u = unregisteredCounts.get(chunk.documentId);
    if (u) u.chunkCount++;
    else unregisteredCounts.set(chunk.documentId, { documentId: chunk.documentId, title: chunk.documentTitle, chunkCount: 1 });
    kept.push({ ...chunk, governance: { status: "unregistered" } });
  }

  const excluded = [...excludedCounts.values()];
  return {
    chunks: kept,
    excluded,
    report: {
      registry: { source: registry.source, sourceRevision: registry.sourceRevision, syncedAt: registry.syncedAt, entries: registry.entries.length },
      chunksIn: chunks.length,
      chunksKept: kept.length,
      excluded,
      restricted: [...restrictedCounts.values()],
      unregistered: [...unregisteredCounts.values()],
      drift,
    },
  };
}

/** One line per governance outcome, for startup logs and the terminal tool. */
export function describeGovernance(report: GovernanceReport): string[] {
  const lines = [
    `Governance: registry ${report.registry.entries} entries (synced ${report.registry.syncedAt}); ${report.chunksKept}/${report.chunksIn} chunks kept.`,
  ];
  for (const e of report.excluded) lines.push(`  excluded ${e.contentId} (${e.chunkCount} chunks): ${e.reason}`);
  for (const r of report.restricted) lines.push(`  restricted ${r.contentId} (${r.chunkCount} chunks): ${r.restriction}`);
  if (report.unregistered.length > 0) lines.push(`  unregistered (no registry record, kept for the pilot): ${report.unregistered.map((u) => u.documentId).join("; ")}`);
  for (const d of report.drift) lines.push(`  drift ${d.contentId} ${d.field}: registry "${d.registry}" vs document "${d.document}"`);
  return lines;
}
