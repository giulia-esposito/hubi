/**
 * Pilot health rating, from numbers the logs already hold. Pure functions: the thresholds live here, in one place, so the
 * rating can be reviewed, tested and changed without touching the report or the page.
 *
 * Proposed 2026-11-09 and agreed with the Product Owner as a starting point; revisit after two weeks of real use.
 * The rating is the worst of its parts. A serious wrong answer on pricing or approvals can still be set to Red by hand
 * in the Notes tab of the monitoring Sheet: numbers cannot see severity.
 */

export type Rating = "green" | "yellow" | "red" | "early";

export interface WindowStats {
  /** Questions that got a response, plus failed turns. */
  turns: number;
  /** Turns that ended in an answer or a "the knowledge does not cover this": clarifying questions are not counted. */
  answerTurns: number;
  /** Answer turns that said the knowledge does not cover the question. */
  notCovered: number;
  errors: number;
  p95LatencyMs: number;
  votes: number;
  helpful: number;
}

export interface Threshold {
  key: "helpful" | "notCovered" | "errors" | "speed";
  label: string;
  /** Plain-language rule, shown next to the number. */
  rule: string;
}

/** Fewer turns than this and the rating says "too early" instead of guessing. */
export const MIN_TURNS = 10;
/** Fewer votes than this and the helpful share is shown but not rated. */
export const MIN_VOTES = 10;

export const THRESHOLDS: Record<Threshold["key"], Threshold> = {
  helpful: { key: "helpful", label: "Helpful votes", rule: "Green at 75% or more, Yellow 60 to 74%, Red below 60% (rated from 10 votes)" },
  notCovered: { key: "notCovered", label: "Questions the knowledge does not cover", rule: "Green up to 20%, Yellow up to 35%, Red above" },
  errors: { key: "errors", label: "Failed turns", rule: "Green up to 1%, Yellow up to 3%, Red above" },
  speed: { key: "speed", label: "Slowest answers (95th percentile)", rule: "Green up to 20 s, Yellow up to 40 s, Red above" },
};

export interface HealthItem {
  key: Threshold["key"];
  label: string;
  rule: string;
  /** The number to show, already formatted ("78%", "14.2 s"), or "not enough votes". */
  value: string;
  rating: Rating;
}

export interface Health {
  overall: Rating;
  items: HealthItem[];
  /** One sentence per item that is not green, for the summary. */
  reasons: string[];
}

const ORDER: Record<Rating, number> = { early: 0, green: 1, yellow: 2, red: 3 };

function byAscendingLimits(value: number, greenMax: number, yellowMax: number): Rating {
  if (value <= greenMax) return "green";
  if (value <= yellowMax) return "yellow";
  return "red";
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`.replace(/\.0%$/, "%");

export function rateHealth(s: WindowStats): Health {
  const items: HealthItem[] = [];
  const reasons: string[] = [];

  const helpfulShare = s.votes ? s.helpful / s.votes : 0;
  const helpfulRating: Rating = s.votes < MIN_VOTES ? "early" : helpfulShare >= 0.75 ? "green" : helpfulShare >= 0.6 ? "yellow" : "red";
  items.push({ ...THRESHOLDS.helpful, value: s.votes < MIN_VOTES ? `${s.votes} vote${s.votes === 1 ? "" : "s"}, not enough to rate` : `${pct(helpfulShare)} of ${s.votes} votes`, rating: helpfulRating });

  const notCoveredShare = s.answerTurns ? s.notCovered / s.answerTurns : 0;
  items.push({ ...THRESHOLDS.notCovered, value: pct(notCoveredShare), rating: byAscendingLimits(notCoveredShare, 0.2, 0.35) });

  const errorShare = s.turns ? s.errors / s.turns : 0;
  items.push({ ...THRESHOLDS.errors, value: pct(errorShare), rating: byAscendingLimits(errorShare, 0.01, 0.03) });

  const seconds = s.p95LatencyMs / 1000;
  items.push({ ...THRESHOLDS.speed, value: `${Math.round(seconds * 10) / 10} s`, rating: byAscendingLimits(seconds, 20, 40) });

  if (s.turns < MIN_TURNS) return { overall: "early", items, reasons: [`Only ${s.turns} question${s.turns === 1 ? "" : "s"} so far, too few to rate the pilot.`] };

  let overall: Rating = "green";
  for (const it of items) {
    if (it.rating === "early") continue;
    if (ORDER[it.rating] > ORDER[overall]) overall = it.rating;
    if (it.rating !== "green") reasons.push(`${it.label}: ${it.value} (${it.rating}).`);
  }
  return { overall, items, reasons };
}

export const RATING_LABELS: Record<Rating, string> = { green: "Green", yellow: "Yellow", red: "Red", early: "Too early to rate" };
