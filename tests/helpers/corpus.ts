import { existsSync } from "node:fs";

/**
 * The real Content Repository is gitignored (it is a ~2 GB business export that
 * lives in GCS, not in GitHub), so a clean checkout, and therefore CI, does not
 * have it. Tests that need it are skipped, with a reason, instead of failing;
 * every synthetic and deterministic test still runs. Locally, with the corpus
 * present, nothing is skipped.
 */
export const HAS_CORPUS = existsSync("Content Repository");

export const SKIP_WITHOUT_CORPUS: boolean | string = HAS_CORPUS ? false : "Content Repository is not present (gitignored); real-corpus tests run locally only";
