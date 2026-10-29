import type { ScoredChunk } from "../retrieval/index.ts";
import { sourceFactsOf } from "./sourceFacts.ts";

/**
 * When the sources of one answer can disagree because of where they sit in time or in the content model
 * (docs/source-selection-design.md, section 2). Detection is deterministic and from labels only; whether the sources
 * actually conflict, and whether one supersedes the other, is a judgment of what they say and is left to the model
 * under the rule in SOURCE_GOVERNANCE_NOTICE. Nothing here ranks, filters or penalises a source.
 */

export type SourceGovernanceReason = "update-and-process" | "same-family-different-dates";

export interface SourceGovernanceSignal {
  reason: SourceGovernanceReason;
  /** 1-based numbers of the sources involved, as numbered in the prompt. */
  sources: number[];
}

/** Two documents of one family count as "different dates" only when they are at least this many days apart. */
export const MIN_DAYS_APART = 30;

const DAY_MS = 86_400_000;

/** Newsletters and the "Trending This Week" collection carry updates, whatever the registry types a particular page. */
export function isUpdateSource(contentType: string, collection: string): boolean {
  return /newsletter/i.test(contentType) || /trending this week/i.test(collection);
}

export function detectSourceGovernance(eligible: ScoredChunk[]): SourceGovernanceSignal | null {
  const byDocument = new Map<string, { update: boolean; family: string; date?: string; sources: number[] }>();
  eligible.forEach((r, i) => {
    const f = sourceFactsOf(r.chunk);
    if (!f.contentType) return; // unregistered: nothing is known about what kind of source it is
    const doc = byDocument.get(r.chunk.documentId) ?? {
      update: isUpdateSource(f.contentType, f.collection),
      family: (f.collection || f.contentType).toLowerCase(),
      date: f.date?.iso,
      sources: [],
    };
    doc.sources.push(i + 1);
    byDocument.set(r.chunk.documentId, doc);
  });
  const docs = [...byDocument.values()];

  const updates = docs.filter((d) => d.update);
  const process = docs.filter((d) => !d.update);
  if (updates.length > 0 && process.length > 0) {
    return { reason: "update-and-process", sources: [...updates, ...process].flatMap((d) => d.sources).sort((a, b) => a - b) };
  }

  const families = new Map<string, typeof process>();
  for (const d of process) families.set(d.family, [...(families.get(d.family) ?? []), d]);
  for (const members of families.values()) {
    const dated = members.filter((d) => d.date);
    if (dated.length < 2) continue;
    const times = dated.map((d) => Date.parse(d.date!));
    if (Math.max(...times) - Math.min(...times) >= MIN_DAYS_APART * DAY_MS) {
      return { reason: "same-family-different-dates", sources: dated.flatMap((d) => d.sources).sort((a, b) => a - b) };
    }
  }
  return null;
}

export function sourceGovernanceNotice(signal: SourceGovernanceSignal): string {
  const why =
    signal.reason === "update-and-process"
      ? "They include both an update-type source (a newsletter or weekly update) and process or training sources."
      : "They include sources of the same kind written on different dates.";
  return (
    `[Source notice] Sources ${signal.sources.join(", ")} carry a Type and an Updated date. ${why} Apply this rule only where these sources speak to the same point:\n` +
    `- If they agree, answer normally and do not mention the comparison.\n` +
    `- Do not prefer a source just because it is newer, and do not treat a newsletter as less reliable just because it is a newsletter. A newer source overrides an older official process only if it explicitly updates, replaces, overrides or supersedes that guidance.\n` +
    `- If a newer source explicitly updates, replaces, overrides or supersedes the older guidance, use the newer information, say plainly that the guidance changed, and cite both.\n` +
    `- If two relevant sources materially conflict and nothing says one supersedes the other, say that the sources differ, give each version with its source, and do not present either as the authoritative one.\n` +
    `- A source that only announces a training, event or update, without the steps or details, does not replace the source that contains them: answer from the source with the details.`
  );
}
