import type { ScoredChunk } from "./index.ts";

/**
 * Retrieval benchmark: pure scoring, no corpus and no model.
 *
 * A case is a question plus the passages that answer it (`relevant`). A
 * relevant passage names a document (by Content ID, or by title for files that
 * have none) and optionally a heading pattern. A case is "hit" at rank r when
 * any of its relevant passages first appears at rank r. Recall@k is the share
 * of cases hit within the top k; MRR averages 1/r. These measure whether
 * retrieval puts the right material in front of the model, which is the only
 * thing retrieval can be blamed for: what the model then does with it is
 * measured elsewhere.
 */

export interface RelevantPassage {
  /** Content ID (RKC-...) or, for files without one, the document id exactly as ingestion assigns it (the file's title). */
  doc: string;
  /** Optional case-insensitive pattern the chunk's heading must match; omitted means any chunk of the document. */
  heading?: string;
}

export interface BenchmarkCase {
  id: string;
  question: string;
  /** exact-term | paraphrase | spanish | portuguese | cross-language | artifact | ... : used only to break results down. */
  category: string;
  relevant: RelevantPassage[];
  /** An earlier user message that states the user's region, so region-specific material is not withheld for lack of context. */
  regionContext?: string;
  /** Why these passages answer the question, for a reviewer checking the label. */
  note?: string;
}

export interface CaseResult {
  id: string;
  category: string;
  /** 1-based rank of the first relevant chunk, or null when none appears within the depth searched. */
  rank: number | null;
  /** Relevant passages found within the depth searched, of those listed. */
  found: number;
  of: number;
  topDocs: string[];
}

export function matches(chunk: ScoredChunk["chunk"], passage: RelevantPassage): boolean {
  if (chunk.documentId !== passage.doc) return false;
  if (!passage.heading) return true;
  return new RegExp(passage.heading, "i").test(chunk.heading ?? "");
}

export function scoreCase(c: BenchmarkCase, ranked: ScoredChunk[]): CaseResult {
  let rank: number | null = null;
  const found = new Set<number>();
  ranked.forEach((r, i) => {
    c.relevant.forEach((p, pi) => {
      if (matches(r.chunk, p)) {
        found.add(pi);
        if (rank === null) rank = i + 1;
      }
    });
  });
  const topDocs: string[] = [];
  for (const r of ranked) if (!topDocs.includes(r.chunk.documentId) && topDocs.length < 5) topDocs.push(r.chunk.documentId);
  return { id: c.id, category: c.category, rank, found: found.size, of: c.relevant.length, topDocs };
}

export interface Metrics {
  cases: number;
  recallAt: Record<number, number>;
  mrr: number;
  /** Mean share of each case's relevant passages found within the depth searched. */
  coverage: number;
}

export const CUTOFFS = [1, 3, 5, 10, 15] as const;

export function summarize(results: CaseResult[]): Metrics {
  const n = results.length;
  const recallAt: Record<number, number> = {};
  for (const k of CUTOFFS) recallAt[k] = n ? results.filter((r) => r.rank !== null && r.rank <= k).length / n : 0;
  const mrr = n ? results.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n : 0;
  const coverage = n ? results.reduce((s, r) => s + r.found / r.of, 0) / n : 0;
  return { cases: n, recallAt, mrr, coverage };
}

export function byCategory(results: CaseResult[]): Record<string, Metrics> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) (groups.get(r.category) ?? groups.set(r.category, []).get(r.category)!).push(r);
  return Object.fromEntries([...groups].map(([k, v]) => [k, summarize(v)]));
}

/** Structural problems in a gold set: duplicate ids, empty relevance, bad patterns. */
export function validateCases(cases: BenchmarkCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) problems.push(`duplicate case id ${c.id}`);
    seen.add(c.id);
    if (!c.question.trim()) problems.push(`${c.id}: empty question`);
    if (c.relevant.length === 0) problems.push(`${c.id}: no relevant passages`);
    for (const p of c.relevant) {
      if (!p.doc.trim()) problems.push(`${c.id}: relevant passage without a document`);
      if (p.heading) {
        try {
          new RegExp(p.heading, "i");
        } catch {
          problems.push(`${c.id}: bad heading pattern ${p.heading}`);
        }
      }
    }
  }
  return problems;
}

export interface RegressionCheck {
  ok: boolean;
  failures: string[];
}

/** Compares a run with a committed baseline; a drop beyond `tolerance` (absolute, 0-1) in Recall@5, Recall@15 or MRR is a regression. */
export function compareToBaseline(current: Metrics, baseline: Metrics, tolerance = 0.02): RegressionCheck {
  const failures: string[] = [];
  const check = (name: string, now: number, then: number) => {
    if (now < then - tolerance) failures.push(`${name} fell from ${then.toFixed(3)} to ${now.toFixed(3)}`);
  };
  check("Recall@5", current.recallAt[5], baseline.recallAt[5]);
  check("Recall@15", current.recallAt[15], baseline.recallAt[15]);
  check("MRR", current.mrr, baseline.mrr);
  return { ok: failures.length === 0, failures };
}
