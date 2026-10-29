import type { ScoredChunk } from "../retrieval/index.ts";

/**
 * Audience conflicts: the retrieved sources are written for different audiences
 * (for example a Sales coaching session and a Customer Success coaching
 * session) and the user has not said which one they are.
 *
 * Hubi does not know who the user is and should not ask by default. But when the
 * sources it is about to use are explicitly labelled for different audiences, an
 * answer that merges them is wrong for everyone: the context-asking eval found the
 * model silently blending two role-specific coaching guides. This is the one case
 * where the corpus itself says the answer depends on who is asking, so it is
 * detected deterministically, from the sources' own labels, and the prompt is told
 * to ask one short question or answer each audience separately. Nothing here
 * names a product, a role or a document: it compares labels.
 *
 * It fires only when two or more distinct documents carry audience labels that
 * share nothing, and neither is labelled for everyone. Overlapping labels
 * ("Sales" and "Sales, CS, WE") are not a conflict, and it stays quiet when the
 * user's own words already name one of the audiences.
 */

export interface AudienceGroup {
  /** The audience labels of these sources, as written in the source metadata. */
  audience: string[];
  /** 1-based numbers of the sources in the prompt that carry this audience. */
  sources: number[];
}

export interface AudienceConflict {
  groups: AudienceGroup[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Labels meaning "everyone": a source marked this way never conflicts with another. */
const EVERYONE = new Set(["revenue", "all revenue", "all", "everyone", "all teams"]);

/** What a user might write for a label, besides the label itself (whole words, case-insensitive). */
const ALIASES: Record<string, RegExp> = {
  cs: /\b(?:cs|csm|client success|customer success)\b/i,
  "client success": /\b(?:cs|csm|client success|customer success)\b/i,
  sales: /\b(?:sales|account executive)\b/i,
  "sales dev": /\b(?:sales dev(?:elopment)?|sdr|bdr)\b/i,
  "sales development": /\b(?:sales dev(?:elopment)?|sdr|bdr)\b/i,
  we: /\b(?:we|wellbeing engagement)\b/i,
  ent: /\b(?:ent|enterprise)\b/i,
  smb: /\b(?:smb|small business|small and medium)\b/i,
};

function mentionsLabel(userText: string, label: string): boolean {
  const alias = ALIASES[norm(label)];
  if (alias && alias.test(userText)) return true;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(userText);
}

export function detectAudienceConflict(eligible: ScoredChunk[], userMessages: string[]): AudienceConflict | null {
  // Audience labels per document, with the prompt numbers of that document's sources.
  const byDocument = new Map<string, { labels: string[]; sources: number[] }>();
  eligible.forEach((r, i) => {
    const labels = (r.chunk.audience ?? []).filter(Boolean);
    if (labels.length === 0) return;
    const entry = byDocument.get(r.chunk.documentId) ?? { labels, sources: [] };
    entry.sources.push(i + 1);
    byDocument.set(r.chunk.documentId, entry);
  });
  const docs = [...byDocument.values()].filter((d) => !d.labels.some((l) => EVERYONE.has(norm(l))));
  if (docs.length < 2) return null;

  // Group documents whose label sets are identical, then keep the groups that share no label with another group.
  const groups = new Map<string, AudienceGroup>();
  for (const d of docs) {
    const key = [...new Set(d.labels.map(norm))].sort().join("|");
    const g = groups.get(key) ?? { audience: d.labels, sources: [] };
    g.sources.push(...d.sources);
    groups.set(key, g);
  }
  const all = [...groups.values()];
  const disjoint = all.filter((g, i) => all.some((h, j) => j !== i && !g.audience.some((a) => h.audience.some((b) => norm(a) === norm(b)))));
  if (disjoint.length < 2) return null;

  // If the user already said which audience they belong to, there is nothing to ask.
  const said = userMessages.join(" ");
  if (disjoint.some((g) => g.audience.some((label) => mentionsLabel(said, label)))) return null;

  return { groups: disjoint.map((g) => ({ audience: g.audience, sources: [...new Set(g.sources)].sort((a, b) => a - b) })) };
}
