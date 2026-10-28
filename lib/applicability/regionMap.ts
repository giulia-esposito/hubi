/**
 * Product-approved operating-region map for the pilot (2026-10-28).
 *
 * Two separate concepts are kept apart on purpose:
 *
 *   country          a place the user or a document can name (Canada, Spain)
 *   operating region the commercial region whose processes apply (United States, Europe)
 *
 * A country resolves to exactly one operating region through this map. Chunks
 * are labeled and matched by operating region; the user's country is kept
 * alongside it. For the current prototype Canada operates as part of the
 * United States region. If governance later separates them, change Canada's
 * `region` here (or add a "Canada" region) and re-label content: no code
 * changes are needed, because nothing else assumes Canada == United States.
 *
 * This is a TypeScript constant, not a data file, so it is always bundled
 * with the code (including the Cloud Run standalone image). It can be
 * extended or overridden locally with data/region-membership.local.json
 * (gitignored) for experiments; see lib/applicability/regions.ts.
 *
 * Language is never a region: nothing in this map is keyed by language.
 * Umbrella terms (LATAM, EMEA, Iberia) are deliberately absent and are
 * rejected if a config tries to add them.
 */
export interface CountryDefinition {
  name: string;
  aliases: string[];
  /** The operating region this country belongs to. */
  region: string;
}

export interface RegionDefinition {
  name: string;
  aliases: string[];
}

export interface RegionMap {
  regions: RegionDefinition[];
  countries: CountryDefinition[];
}

export const APPROVED_REGION_MAP: RegionMap = {
  regions: [
    { name: "Brazil", aliases: ["Brazil", "Brasil", "BR"] },
    { name: "United States", aliases: ["US", "USA", "U.S.", "United States"] },
    { name: "SS Latam", aliases: ["SS Latam", "SS-Latam", "SSL"] },
    { name: "Europe", aliases: ["Europe"] },
  ],
  countries: [
    { name: "Brazil", aliases: ["Brasil"], region: "Brazil" },

    { name: "Mexico", aliases: ["México"], region: "SS Latam" },
    { name: "Chile", aliases: [], region: "SS Latam" },
    { name: "Argentina", aliases: [], region: "SS Latam" },

    { name: "United Kingdom", aliases: ["UK"], region: "Europe" },
    { name: "Ireland", aliases: [], region: "Europe" },
    { name: "Spain", aliases: ["España"], region: "Europe" },
    { name: "Germany", aliases: [], region: "Europe" },
    { name: "Romania", aliases: [], region: "Europe" },
    { name: "Italy", aliases: [], region: "Europe" },
    { name: "Portugal", aliases: [], region: "Europe" },
    { name: "Netherlands", aliases: ["Holland"], region: "Europe" },
    { name: "France", aliases: [], region: "Europe" },
    // Benelux is a union of countries, listed by Product as a single entry.
    { name: "Benelux", aliases: [], region: "Europe" },

    { name: "United States", aliases: ["US", "USA", "U.S."], region: "United States" },
    // Same commercial region as the United States for the current prototype.
    { name: "Canada", aliases: [], region: "United States" },
  ],
};
