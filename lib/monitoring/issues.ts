/**
 * Pilot issues: the questions Hubi could not answer well, grouped so a retry is one issue and not five.
 *
 * An issue is a normalized question. It is seen as "Not covered" (no grounded answer), "Reported incorrect" (a not helpful
 * vote tagged wrong) or "Not helpful" (any other not helpful vote). The monitoring Sheet's Issues tab holds the triage:
 * cause, status and fix, which people and the daily check fill in. This module only finds and groups the candidates and
 * says whether the same question got a helpful vote since, so the status can be moved to "Probably solved".
 *
 * The page (monitoring/apps-script/Index.html) repeats `normalizeQuestion` to match votes to issues: keep the two equal.
 */

export type IssueKind = "Not covered" | "Reported incorrect" | "Not helpful";

export interface IssueEvent {
  question: string;
  kind: IssueKind;
  /** ISO timestamp. */
  at: string;
}

export interface HelpfulVote {
  question: string;
  /** ISO timestamp. */
  at: string;
}

export interface IssueCandidate {
  key: string;
  question: string;
  seenAs: IssueKind[];
  firstSeen: string;
  lastSeen: string;
  timesSeen: number;
  /** Date (YYYY-MM-DD) of the first helpful vote on the same question after its last failure, or "". */
  helpfulSince: string;
}

export function normalizeQuestion(question: string): string {
  return String(question ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const KIND_ORDER: IssueKind[] = ["Reported incorrect", "Not covered", "Not helpful"];

export function groupIssues(events: IssueEvent[], helpful: HelpfulVote[]): IssueCandidate[] {
  const groups = new Map<string, IssueEvent[]>();
  for (const e of events) {
    const key = normalizeQuestion(e.question);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out: IssueCandidate[] = [];
  for (const [key, list] of groups) {
    const times = list.map((e) => e.at).sort();
    const lastSeen = times[times.length - 1];
    const later = helpful
      .filter((a) => normalizeQuestion(a.question) === key && a.at > lastSeen)
      .map((a) => a.at)
      .sort()[0];
    out.push({
      key,
      question: list[0].question,
      seenAs: KIND_ORDER.filter((k) => list.some((e) => e.kind === k)),
      firstSeen: times[0].slice(0, 10),
      lastSeen: lastSeen.slice(0, 10),
      timesSeen: list.length,
      helpfulSince: later ? later.slice(0, 10) : "",
    });
  }
  return out.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}
