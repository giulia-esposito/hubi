/**
 * Task Planning V0: the PRIMARY job-to-be-done of a request, as self-reported
 * by the reasoning model in the same call that produces the answer (no second
 * model call). This is deliberately a separate dimension from TurnKind:
 *
 *   planningMode = what kind of work the user asked Hubi to perform
 *   turnKind     = the grounding / answerability outcome of the response
 *
 * Planning mode never changes which knowledge is retrieved or eligible -- it
 * only governs what Hubi does with knowledge that retrieval already supplied.
 * See docs/task-planning-architecture.md and
 * docs/milestone-retrieval-v2-taskplanning-v0-plan.md.
 */
export const PLANNING_MODES = ["knowledge-retrieval", "knowledge-synthesis", "business-assistance"] as const;

export type PlanningMode = (typeof PLANNING_MODES)[number] | "unknown";

/** Tag keyword (as written by the model) -> PlanningMode. */
export const PLANNING_MODE_KEYWORDS: Record<string, PlanningMode> = {
  KNOWLEDGE_RETRIEVAL: "knowledge-retrieval",
  KNOWLEDGE_SYNTHESIS: "knowledge-synthesis",
  BUSINESS_ASSISTANCE: "business-assistance",
};

export const PLANNING_MODE_TAG_PREFIX = "[[HUBI:MODE:";
