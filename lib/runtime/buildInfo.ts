/**
 * Which commit is running. The deploy script writes build-info.json into the
 * exported commit and next.config.mjs inlines it at build time (the literal
 * process.env.HUBI_BUILD_* expressions below are replaced by the bundler, so
 * they must stay written exactly like this). Local development and tests report
 * "unknown".
 */
export interface BuildInfo {
  commit: string;
  branch: string;
  builtAt: string;
}

export const BUILD_INFO: BuildInfo = {
  commit: process.env.HUBI_BUILD_COMMIT || "unknown",
  branch: process.env.HUBI_BUILD_BRANCH || "unknown",
  builtAt: process.env.HUBI_BUILD_TIME || "unknown",
};
