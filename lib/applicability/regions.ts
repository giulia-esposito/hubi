import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APPROVED_REGION_MAP, type CountryDefinition, type RegionDefinition, type RegionMap } from "./regionMap.ts";

/**
 * Region vocabulary for the Applicability Layer (Finding #002).
 *
 * Country identity and operating-region identity are separate. The
 * Product-approved map (lib/applicability/regionMap.ts) says which operating
 * region each country belongs to; chunks are matched by operating region and
 * the user's country is carried alongside. Canada therefore resolves to the
 * United States region today without being the same thing as the United
 * States, so the two can diverge later by editing the map alone.
 *
 * "Global" comes only from source metadata that literally says so; it is
 * never detected in user text. Ambiguous umbrella terms (LATAM, EMEA,
 * Iberia...) and language names never resolve to a region, and an override
 * config that tries to use one is rejected. Language is never a proxy for
 * region (Finding #002).
 */

export const GLOBAL_REGION = "Global";

export type { CountryDefinition, RegionDefinition, RegionMap };

/** Umbrella terms and language names that must never resolve to a region. */
export const AMBIGUOUS_TERMS: readonly string[] = [
  "latam",
  "latin america",
  "emea",
  "iberia",
  "north america",
  "south america",
  "americas",
  "apac",
  "english",
  "spanish",
  "portuguese",
  "español",
  "espanol",
  "português",
  "portugues",
  "inglés",
  "ingles",
  "spanish-speaking",
  "portuguese-speaking",
  "english-speaking",
  "global",
];

const AMBIGUOUS_SET = new Set(AMBIGUOUS_TERMS);

/** Optional local override/extension, merged on top of the approved map. */
export interface RegionConfigFile {
  regions?: Record<string, { aliases?: string[]; countries?: string[] }>;
  countries?: Record<string, { region: string; aliases?: string[] }>;
}

export interface RegionVocabulary {
  regions: RegionDefinition[];
  countries: CountryDefinition[];
  /** Problems found in the optional config (rejected aliases, bad shapes). Never silently dropped. */
  warnings: string[];
  /** Where the optional override config was read from, if one was loaded. */
  configPath: string | null;
}

function normalizeToken(token: string): string {
  return token
    .trim()
    .replace(/^[\s"'(\[]+|[\s"')\].;:]+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isAmbiguous(term: string): boolean {
  return AMBIGUOUS_SET.has(normalizeToken(term));
}

/**
 * Builds a vocabulary from the approved map plus an optional override config.
 * Pure and testable: the file-reading wrapper is getRegionVocabulary().
 * Pass `base` to start from something other than the approved map (tests).
 */
export function createRegionVocabulary(
  config?: RegionConfigFile | null,
  configPath: string | null = null,
  base: RegionMap = APPROVED_REGION_MAP
): RegionVocabulary {
  const regions: RegionDefinition[] = base.regions.map((r) => ({ name: r.name, aliases: [...r.aliases] }));
  const countries: CountryDefinition[] = base.countries.map((c) => ({ name: c.name, aliases: [...c.aliases], region: c.region }));
  const warnings: string[] = [];

  const ensureRegion = (name: string): RegionDefinition | null => {
    if (normalizeToken(name) === "global" || isAmbiguous(name)) {
      warnings.push(`Region "${name}" in config is reserved or ambiguous and was ignored.`);
      return null;
    }
    let region = regions.find((r) => normalizeToken(r.name) === normalizeToken(name));
    if (!region) {
      region = { name, aliases: [name] };
      regions.push(region);
    }
    return region;
  };

  for (const [name, def] of Object.entries(config?.regions ?? {})) {
    const region = ensureRegion(name);
    if (!region) continue;
    for (const alias of def.aliases ?? []) {
      if (typeof alias !== "string" || !alias.trim()) continue;
      if (isAmbiguous(alias)) {
        warnings.push(`Alias "${alias}" for region "${region.name}" is an ambiguous umbrella term or language name and was rejected.`);
        continue;
      }
      region.aliases.push(alias.trim());
    }
    // Legacy shape: a list of country names under a region.
    for (const country of def.countries ?? []) {
      if (typeof country !== "string" || !country.trim()) continue;
      if (isAmbiguous(country)) {
        warnings.push(`Country "${country}" for region "${region.name}" is an ambiguous term and was rejected.`);
        continue;
      }
      countries.push({ name: country.trim(), aliases: [], region: region.name });
    }
  }

  for (const [name, def] of Object.entries(config?.countries ?? {})) {
    if (isAmbiguous(name)) {
      warnings.push(`Country "${name}" in config is an ambiguous term and was ignored.`);
      continue;
    }
    const region = ensureRegion(def.region);
    if (!region) continue;
    const aliases: string[] = [];
    for (const alias of def.aliases ?? []) {
      if (typeof alias !== "string" || !alias.trim()) continue;
      if (isAmbiguous(alias)) {
        warnings.push(`Alias "${alias}" for country "${name}" is an ambiguous umbrella term or language name and was rejected.`);
        continue;
      }
      aliases.push(alias.trim());
    }
    const existing = countries.find((c) => normalizeToken(c.name) === normalizeToken(name));
    if (existing) {
      existing.region = region.name;
      existing.aliases.push(...aliases);
    } else {
      countries.push({ name, aliases, region: region.name });
    }
  }

  return { regions, countries, warnings, configPath };
}

export const DEFAULT_REGION_CONFIG_PATH = path.join("data", "region-membership.local.json");

let cached: RegionVocabulary | null = null;

/**
 * Loads the vocabulary once per process: the approved map, plus an optional
 * local override from HUBI_REGION_CONFIG or data/region-membership.local.json.
 * A missing override file is the normal state; an unreadable or invalid one is
 * reported in `warnings` and the approved map still applies.
 */
export function getRegionVocabulary(): RegionVocabulary {
  if (cached) return cached;
  const configured = process.env.HUBI_REGION_CONFIG?.trim();
  const configPath = configured || path.join(process.cwd(), DEFAULT_REGION_CONFIG_PATH);
  // The path is dynamic on purpose (an optional local override). Without the ignore
  // comments below the bundler traces the whole project into the production output.
  if (!existsSync(/*turbopackIgnore: true*/ configPath)) {
    cached = createRegionVocabulary(null);
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(/*turbopackIgnore: true*/ configPath, "utf8")) as RegionConfigFile;
    cached = createRegionVocabulary(parsed, configPath);
  } catch (err) {
    cached = createRegionVocabulary(null);
    cached.warnings.push(`Region config at ${configPath} could not be read (${String((err as Error).message ?? err)}); using the approved map only.`);
  }
  return cached;
}

/** For tests: forget the cached vocabulary so the next call re-reads the environment. */
export function resetRegionVocabularyCache(): void {
  cached = null;
}

export type RegionScope = "global" | "regional" | "unspecified";

export interface ParsedRegionMetadata {
  regions: string[];
  scope: RegionScope;
  /** Metadata tokens that matched nothing in the vocabulary. They are reported, never guessed and never treated as Global. */
  unrecognized: string[];
}

const METADATA_SPLIT = /\s*(?:,|;|\/|\||&|\band\b)\s*/i;

function resolveMetadataToken(vocabulary: RegionVocabulary, normalized: string): string | null {
  const region = vocabulary.regions.find((r) => normalizeToken(r.name) === normalized || r.aliases.some((a) => normalizeToken(a) === normalized));
  if (region) return region.name;
  const country = vocabulary.countries.find((c) => normalizeToken(c.name) === normalized || c.aliases.some((a) => normalizeToken(a) === normalized));
  return country ? country.region : null;
}

/**
 * Parses a document-level "Target Region" value into canonical operating
 * regions. A token may be a region (or alias) or a country; a country resolves
 * to its operating region.
 *
 *   Global only when a token is literally "Global".
 *   Regional when at least one token is known and none is Global.
 *   Unspecified when there is no value, or no token is recognized: unspecified
 *   means "scope unknown". It is never Global and never matches any region.
 */
export function parseRegionMetadata(vocabulary: RegionVocabulary, raw: string | null | undefined): ParsedRegionMetadata {
  if (!raw || !raw.trim()) return { regions: [], scope: "unspecified", unrecognized: [] };

  const regions: string[] = [];
  const unrecognized: string[] = [];
  let sawGlobal = false;

  for (const token of raw.split(METADATA_SPLIT)) {
    const normalized = normalizeToken(token);
    if (!normalized) continue;
    if (normalized === "global") {
      sawGlobal = true;
      continue;
    }
    const region = resolveMetadataToken(vocabulary, normalized);
    if (region) {
      if (!regions.includes(region)) regions.push(region);
    } else {
      unrecognized.push(token.trim());
    }
  }

  if (sawGlobal) return { regions: [GLOBAL_REGION], scope: "global", unrecognized };
  if (regions.length > 0) return { regions, scope: "regional", unrecognized };
  return { regions: [], scope: "unspecified", unrecognized };
}

/** Audience is label-only in this slice: split into trimmed values, no vocabulary, no gating. */
export function parseAudience(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s*(?:,|;|\/|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Short all-caps aliases (US, BR, SSL, USA, UK, U.S.) must match case-sensitively in user text: "us" is a pronoun. */
function isCaseSensitiveAlias(alias: string): boolean {
  return alias.length <= 4 && alias === alias.toUpperCase() && /[A-Z]/.test(alias);
}

// Place names that are part of a different place when preceded by a qualifier.
const NOT_PRECEDED_BY: Record<string, RegExp> = {
  mexico: /\bnew\s+$/i,
};

function matchesInText(text: string, term: string): boolean {
  const flags = isCaseSensitiveAlias(term) ? "gu" : "giu";
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, flags);
  const guard = NOT_PRECEDED_BY[term.toLowerCase()];
  for (const match of text.matchAll(pattern)) {
    if (guard && guard.test(text.slice(0, match.index ?? 0))) continue;
    return true;
  }
  return false;
}

export interface TaskContext {
  /** Operating regions the user's situation falls in (empty when unknown). */
  regions: string[];
  /** Countries the user named, kept separate from the operating region they resolve to. */
  countries: string[];
}

/** Regions and countries named in one message. Never language, never umbrella terms. */
function contextInMessage(vocabulary: RegionVocabulary, message: string): TaskContext {
  const regions: string[] = [];
  const countries: string[] = [];
  for (const region of vocabulary.regions) {
    if (region.aliases.some((a) => matchesInText(message, a)) && !regions.includes(region.name)) regions.push(region.name);
  }
  for (const country of vocabulary.countries) {
    if ([country.name, ...country.aliases].some((t) => matchesInText(message, t))) {
      if (!countries.includes(country.name)) countries.push(country.name);
      if (!regions.includes(country.region)) regions.push(country.region);
    }
  }
  return { regions, countries };
}

/**
 * Task context from the user's own messages (precedence rule: the most recent
 * explicit statement wins). Scans from the latest message backwards and
 * returns the regions and countries named in the first message that names
 * any. The language the user writes in is never an input.
 */
export function detectTaskContext(vocabulary: RegionVocabulary, userMessages: string[]): TaskContext {
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const found = contextInMessage(vocabulary, userMessages[i]);
    if (found.regions.length > 0) return found;
  }
  return { regions: [], countries: [] };
}

/** Operating regions only; see detectTaskContext for the user's countries. */
export function detectTaskRegions(vocabulary: RegionVocabulary, userMessages: string[]): string[] {
  return detectTaskContext(vocabulary, userMessages).regions;
}

/**
 * True when the user themselves says the answer depends on where they work
 * ("my region", "mi región", "minha região", "in my country"...). Combined with
 * an unresolved region and withheld region-specific material, this makes the
 * region question mandatory: region is declared to matter and is not stated.
 * It is a statement about the user's own words, not about any language.
 */
export function refersToOwnRegion(message: string): boolean {
  return /\b(?:my|our)\s+(?:region|country|market|territory|area)\b|\b(?:mi|nuestra|mis|nuestro)\s+(?:regi[oó]n|pa[ií]s|mercado|territorio|zona)\b|\b(?:minha|nossa|meu|nosso)\s+(?:regi[aã]o|pa[ií]s|mercado|territ[oó]rio)\b/i.test(message);
}
