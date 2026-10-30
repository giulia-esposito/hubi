import type { ScoredChunk } from "../retrieval/index.ts";

/**
 * Progressive clarification on the dimension that changes the answer (docs/pilot-conversations-fixes.md, fix 2).
 *
 * Region is asked by the Applicability Layer. After it, another dimension can still split the answer: found in production, where
 * "Which contract should I use?" for Brazil has one answer for the partner (indirect) channel and another for direct sales, and
 * Hubi silently answered for the partner channel. Differing audience labels alone are not enough to ask (the Sales and CS coaching
 * recordings carry different labels and teach the same method), so this is two steps:
 *
 *   1. Deterministic candidates: two or more documents that each match the question about as well as the best one, written for
 *      audiences that share no label. Documents are drawn from a deeper search than the answer set, because the competing
 *      document is often not in it. No candidates, no further work: a general question never reaches step 2.
 *   2. One fast model call reads short excerpts of each group and decides whether the answer would materially differ and whether
 *      the user has already said which situation applies. It replies NONE, or one short question. A failed call means no question:
 *      the answer then proceeds as it did before.
 */

export const SCOPE_MIN_RELATIVE_SCORE = 0.6;
const MAX_DOCS_PER_GROUP = 2;
const EXCERPT_CHARS = 700;
const MAX_QUESTION_CHARS = 240;

export interface ScopeGroupDocument {
  documentId: string;
  title: string;
  heading: string | null;
  excerpt: string;
}

export interface ScopeGroup {
  /** The audience labels the group's documents carry, as written in the source metadata. */
  audience: string[];
  documents: ScopeGroupDocument[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Labels meaning "everyone": a document marked this way is not specific to a situation. */
const EVERYONE = new Set(["revenue", "all revenue", "all", "everyone", "all teams", "global", "[global]"]);

/**
 * `pool` is the answer set plus a deeper search, already limited to chunks the Applicability Layer would let through.
 * `bestScore` is the best match for the question in the pool.
 */
export function findScopeCandidates(pool: ScoredChunk[], bestScore: number): ScopeGroup[] | null {
  if (bestScore <= 0) return null;
  const byDocument = new Map<string, { labels: string[]; best: ScoredChunk }>();
  for (const r of pool) {
    if (r.score < bestScore * SCOPE_MIN_RELATIVE_SCORE) continue;
    const labels = (r.chunk.audience ?? []).filter(Boolean);
    if (labels.length === 0 || labels.some((l) => EVERYONE.has(norm(l)))) continue;
    const entry = byDocument.get(r.chunk.documentId);
    if (!entry) byDocument.set(r.chunk.documentId, { labels, best: r });
    else if (r.score > entry.best.score) entry.best = r;
  }
  const groups = new Map<string, ScopeGroup & { docScores: { doc: ScopeGroupDocument; score: number }[] }>();
  for (const [documentId, { labels, best }] of byDocument) {
    const key = [...new Set(labels.map(norm))].sort().join("|");
    const group = groups.get(key) ?? { audience: labels, documents: [], docScores: [] };
    group.docScores.push({
      doc: { documentId, title: best.chunk.documentTitle, heading: best.chunk.heading, excerpt: best.chunk.text.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS) },
      score: best.score,
    });
    groups.set(key, group);
  }
  const all = [...groups.values()];
  const disjoint = all.filter((g, i) => all.some((h, j) => j !== i && !g.audience.some((a) => h.audience.some((b) => norm(a) === norm(b)))));
  if (disjoint.length < 2) return null;
  return disjoint.map((g) => ({
    audience: g.audience,
    documents: g.docScores.sort((a, b) => b.score - a.score).slice(0, MAX_DOCS_PER_GROUP).map((d) => d.doc),
  }));
}

export const SCOPE_JUDGE_SYSTEM = "You are a careful reviewer for an internal knowledge assistant. Follow the requested format exactly.";

export function buildScopeJudgePrompt(question: string, userMessages: string[], groups: ScopeGroup[]): string {
  const described = groups
    .map((g, i) => {
      const docs = g.documents.map((d) => `  - "${d.title}"${d.heading ? ` (${d.heading})` : ""}: ${d.excerpt}`).join("\n");
      return `Situation ${i + 1}, material written for ${g.audience.join(", ")}:\n${docs}`;
    })
    .join("\n\n");
  return (
    `A user asked an internal knowledge assistant: "${question}"\n` +
    `Everything the user has said in this conversation: ${userMessages.map((m) => `"${m}"`).join(" / ")}\n\n` +
    `The approved knowledge has material written for different situations:\n\n${described}\n\n` +
    `Answer these checks in exactly this format, one per line:\n` +
    groups.map((_, i) => `SITUATION_${i + 1}_EVIDENCE: copy word for word, from the material of situation ${i + 1} above, the sentence that directly answers the user's question; if that material is about a different topic or only related to the question, write NONE.\n`).join("") +
    `DIFFERENT_REQUIREMENTS: YES or NO (among the situations with evidence, would the answer differ in rules, requirements, documents or contracts, so that using the wrong situation's guidance gives wrong or unusable instructions? Different wording, examples or participants, or roles that each do their own part of one process, are NO.)\n` +
    `USER_ALREADY_SAID: YES or NO (has the user already said which situation applies?)\n` +
    `QUESTION: if at least two situations have evidence, DIFFERENT_REQUIREMENTS is YES and USER_ALREADY_SAID is NO, ONE short question in the language of the user's question asking which situation applies, naming only the situations that have evidence, in plain words and not by internal label; otherwise NONE.`
  );
}

const plainText = (s: string) => s.toLowerCase().replace(/["'‘’“”`*]/g, "").replace(/\s+/g, " ").trim();
const MIN_EVIDENCE_CHARS = 15;

/**
 * A situation counts as answering the question only when the judge can quote, word for word, a sentence of that situation's own
 * material that answers it. The quote is checked against the excerpts the judge was shown, so a claim that two documents address
 * the same question cannot be asserted: it has to be shown. Material about another topic has nothing to quote.
 */
function hasVerifiedEvidence(text: string, index: number, group: ScopeGroup): boolean {
  const quote = text.match(new RegExp(`^\\s*SITUATION_${index + 1}_EVIDENCE\\s*:\\s*(.+)$`, "im"))?.[1] ?? "";
  const evidence = plainText(quote).replace(/(\.\.\.|…)$/, "").trim();
  if (evidence.length < MIN_EVIDENCE_CHARS || /^none\b/.test(evidence)) return false;
  return group.documents.some((d) => plainText(d.excerpt).includes(evidence));
}

/** At least two situations need verified evidence and the two checks must point to asking, and the question must be a question; anything else means "do not ask". */
export function parseScopeJudgement(reply: string, groups: ScopeGroup[]): string | null {
  const text = reply.replace(/\[\[HUBI:[^\]]*\]\]/g, "");
  const flag = (name: string) => text.match(new RegExp(`${name}\\s*:\\s*(YES|NO)`, "i"))?.[1].toUpperCase();
  // Candidate groups can include documents that only touch the topic; they have nothing to quote and drop out. Two or more evidenced situations are needed to ask.
  if (groups.filter((g, i) => hasVerifiedEvidence(text, i, g)).length < 2) return null;
  if (flag("DIFFERENT_REQUIREMENTS") !== "YES" || flag("USER_ALREADY_SAID") !== "NO") return null;
  const line = text.match(/^\s*QUESTION\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  if (!line || /^none\b/i.test(line) || !/[?¿]/.test(line)) return null;
  return line.replace(/^["'`*\s]+|["'`*\s]+$/g, "").slice(0, MAX_QUESTION_CHARS);
}

export interface ScopeEngine {
  (prompt: string, system: string, opts?: { timeoutMs?: number; fast?: boolean }): Promise<{ ok: boolean; text: string; error?: string }>;
}

export const SCOPE_JUDGE_TIMEOUT_MS = 10_000;

export interface ScopeJudgement {
  /** The clarifying question to ask, or null when the answer does not need one. */
  question: string | null;
  ms: number;
  error?: string;
}

/** Never throws: a failed call returns no question, so the turn proceeds as before. */
export async function judgeScope(engine: ScopeEngine, question: string, userMessages: string[], groups: ScopeGroup[]): Promise<ScopeJudgement> {
  const start = performance.now();
  try {
    const reply = await engine(buildScopeJudgePrompt(question, userMessages, groups), SCOPE_JUDGE_SYSTEM, { timeoutMs: SCOPE_JUDGE_TIMEOUT_MS, fast: true });
    return { question: reply.ok ? parseScopeJudgement(reply.text, groups) : null, ms: Math.round(performance.now() - start), error: reply.ok ? undefined : String(reply.error ?? "engine failed") };
  } catch (err) {
    return { question: null, ms: Math.round(performance.now() - start), error: String((err as Error)?.message ?? err) };
  }
}
