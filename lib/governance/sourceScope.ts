import type { ScoredChunk } from "../retrieval/index.ts";

/**
 * Scope-aware synthesis (docs/pilot-conversations-fixes.md, fix 4).
 *
 * Found in production: "How can I explain Wellhub to a client?" was answered with a US-only pricing narrative that was never fully
 * implemented and with SMB contract rules, each as a numbered step of the general explanation; "Which contract should I use?" for Brazil
 * was answered from the partner-channel training as if it were the contract rule. A source can be limited by the registry (a restriction
 * caveat) or by who it was written for (an audience of one or two named groups), and a title can say more (a tier, segment, channel or
 * program). The sources already carry the first two as labels; this names them as limits and tells the model what a limit means for the
 * answer. It does not drop a scoped source: an applicable one is exactly what some questions need.
 */

/** Labels meaning "everyone": a source marked this way is not specific to a group. */
const EVERYONE = new Set(["revenue", "all revenue", "all", "everyone", "all teams", "global", "[global]"]);
/** A source written for more than this many named groups (Sales, Sales Dev, CS) is general enough to read as general guidance. */
const MAX_NAMED_GROUPS_FOR_A_LIMIT = 2;

export interface ScopedSource {
  /** 1-based number of the source in the prompt. */
  source: number;
  /** What limits it, in plain words. */
  limits: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function scopeLimitsOf(chunk: ScoredChunk["chunk"]): string[] {
  const limits: string[] = [];
  if (chunk.governance?.restriction) limits.push(`registry restriction: ${chunk.governance.restriction}`);
  const labels = (chunk.audience ?? []).filter(Boolean);
  if (labels.length > 0 && labels.length <= MAX_NAMED_GROUPS_FOR_A_LIMIT && !labels.some((l) => EVERYONE.has(norm(l)))) limits.push(`written for ${labels.join(" and ")} only`);
  return limits;
}

/** The line shown under a source header when it has limits, or "". */
export function scopeLine(chunk: ScoredChunk["chunk"]): string {
  const limits = scopeLimitsOf(chunk);
  return limits.length > 0 ? `Scope: ${limits.join("; ")}` : "";
}

export function scopedSources(results: ScoredChunk[]): ScopedSource[] {
  return results.map((r, i) => ({ source: i + 1, limits: scopeLimitsOf(r.chunk) })).filter((s) => s.limits.length > 0);
}

export function scopeNotice(scoped: ScopedSource[]): string {
  return (
    `[Scope notice] Sources ${scoped.map((s) => s.source).join(", ")} carry a "Scope" line: they are limited to the situation it names. A source whose title names a tier, segment, channel, region or program is limited to it too. ` +
    `Apply this to the answer:\n` +
    `- Write the answer in two parts. First the general guidance, from sources without a limit only. Then, only if a limited source is directly relevant, a separate part with a heading such as "Only for specific situations", where each limited source is introduced by the situation it covers. Never put limited content in the numbered steps or bullets of the general part, and never word it as a general rule.\n` +
    `- If no source without a limit supports a general answer, say so in the first sentence and give only what the limited sources cover, labelled with their situation.\n` +
    `- If the user's own words show that a limited source applies to them, or it is the only answer to the question, treat that situation as the subject of the answer and say plainly at the start which situation it covers.\n` +
    `- If the sources hold materially different procedures for different situations (for example direct sales and a partner channel), give each one under its own clearly labelled heading ("If ...:") and do not merge them or choose one silently.\n` +
    `- If only one situation is supported by the sources, say at the start which situation your answer covers and that the sources do not cover the others; do not word it as if it applied to everyone.\n` +
    `- If a limited source is only loosely related to the question, leave it out. If a registry restriction says the content was not fully implemented, or only released somewhere, say so next to that content.`
  );
}
