import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Region vocabulary for the Applicability Layer (Finding #002).
 *
 * Only the aliases Product has approved are built in:
 *   Brazil         <- Brazil, Brasil, BR
 *   United States  <- US, USA, U.S., United States
 *   SS Latam       <- SS Latam, SS-Latam, SSL
 *   Global         <- Global, and only when explicitly stated in source metadata
 *
 * Country membership (which countries belong to SS Latam, Europe, Canada...),
 * any further alias (EU, Europe...) and any extra region are NOT hard-coded:
 * they come from an optional local config file that is deliberately not
 * committed until Content/Governance validates the vocabulary (see
 * data/region-membership.example.json). Without that file, a country name
 * resolves to nothing.
 *
 * Ambiguous umbrella terms (LATAM, EMEA, Iberia...) and language names never
 * resolve to a region, and a config entry that tries to use one is rejected.
 * Language is never a proxy for region (Finding #002).
 */

export const GLOBAL_REGION = "Global";

export interface RegionDefinition {
  name: string;
  aliases: string[];
  /** Country names that resolve to this region in user text. Config-only: none are built in. */
  countries: string[];
}

const BUILT_IN_REGIONS: RegionDefinition[] = [
  { name: "Brazil", aliases: ["Brazil", "Brasil", "BR"], countries: [] },
  { name: "United States", aliases: ["US", "USA", "U.S.", "United States"], countries: [] },
  { name: "SS Latam", aliases: ["SS Latam", "SS-Latam", "SSL"], countries: [] },
];

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

export interface RegionConfigFile {
  regions?: Record<string, { aliases?: string[]; countries?: string[] }>;
}

export interface RegionVocabulary {
  regions: RegionDefinition[];
  /** Problems found in the optional config (rejected aliases, bad shapes). Never silently dropped. */
  warnings: string[];
  /** Where the optional config was read from, if one was loaded. */
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

/**
 * Builds a vocabulary from the built-in approved aliases plus an optional
 * config. Pure and testable: the file-reading wrapper is getRegionVocabulary().
 */
export function createRegionVocabulary(config?: RegionConfigFile | null, configPath: string | null = null): RegionVocabulary {
  const regions: RegionDefinition[] = BUILT_IN_REGIONS.map((r) => ({ ...r, aliases: [...r.aliases], countries: [...r.countries] }));
  const warnings: string[] = [];

  for (const [name, def] of Object.entries(config?.regions ?? {})) {
    if (normalizeToken(name) === "global" || AMBIGUOUS_SET.has(normalizeToken(name))) {
      warnings.push(`Region "${name}" in config is reserved or ambiguous and was ignored.`);
      continue;
    }
    let region = regions.find((r) => normalizeToken(r.name) === normalizeToken(name));
    if (!region) {
      region = { name, aliases: [name], countries: [] };
      regions.push(region);
    }
    for (const alias of def.aliases ?? []) {
      if (typeof alias !== "string" || !alias.trim()) continue;
      if (AMBIGUOUS_SET.has(normalizeToken(alias))) {
        warnings.push(`Alias "${alias}" for region "${region.name}" is an ambiguous umbrella term or language name and was rejected.`);
        continue;
      }
      region.aliases.push(alias.trim());
    }
    for (const country of def.countries ?? []) {
      if (typeof country !== "string" || !country.trim()) continue;
      if (AMBIGUOUS_SET.has(normalizeToken(country))) {
        warnings.push(`Country "${country}" for region "${region.name}" is an ambiguous term and was rejected.`);
        continue;
      }
      region.countries.push(country.trim());
    }
  }

  return { regions, warnings, configPath };
}

export const DEFAULT_REGION_CONFIG_PATH = path.join("data", "region-membership.local.json");

let cached: RegionVocabulary | null = null;

/**
 * Loads the vocabulary once per process. The config path can be overridden
 * with HUBI_REGION_CONFIG. A missing file is the normal state until
 * Content/Governance validates the membership; an unreadable or invalid one
 * is reported in `warnings` and the built-in approved aliases still apply.
 */
export function getRegionVocabulary(): RegionVocabulary {
  if (cached) return cached;
  const configured = process.env.HUBI_REGION_CONFIG?.trim();
  const configPath = configured || path.join(process.cwd(), DEFAULT_REGION_CONFIG_PATH);
  if (!existsSync(configPath)) {
    cached = createRegionVocabulary(null);
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as RegionConfigFile;
    cached = createRegionVocabulary(parsed, configPath);
  } catch (err) {
    cached = createRegionVocabulary(null);
    cached.warnings.push(`Region config at ${configPath} could not be read (${String((err as Error).message ?? err)}); using built-in aliases only.`);
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

/**
 * Parses a document-level "Target Region" value into canonical regions.
 *
 *   Global only when a token is literally "Global".
 *   Regional when at least one token is a known region and none is Global.
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
    const match = vocabulary.regions.find((r) => r.aliases.some((a) => normalizeToken(a) === normalized) || normalizeToken(r.name) === normalized);
    if (match) {
      if (!regions.includes(match.name)) regions.push(match.name);
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

/** Short all-caps aliases (US, BR, SSL, USA, U.S., EU) must match case-sensitively in user text: "us" is a pronoun. */
function isCaseSensitiveAlias(alias: string): boolean {
  return alias.length <= 4 && alias === alias.toUpperCase() && /[A-Z]/.test(alias);
}

function matchesInText(text: string, term: string): boolean {
  const flags = isCaseSensitiveAlias(term) ? "" : "i";
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, `u${flags}`);
  return pattern.test(text);
}

/** Regions named in one message: approved aliases and, when configured, country names. Never language, never umbrella terms. */
function regionsInMessage(vocabulary: RegionVocabulary, message: string): string[] {
  const found: string[] = [];
  for (const region of vocabulary.regions) {
    const terms = [...region.aliases, ...region.countries];
    if (terms.some((term) => matchesInText(message, term))) found.push(region.name);
  }
  return found;
}

/**
 * Task region from the user's own messages (precedence rule: the most recent
 * explicit statement wins). Scans from the latest message backwards and
 * returns the regions named in the first message that names any. The
 * language the user writes in is never an input.
 */
export function detectTaskRegions(vocabulary: RegionVocabulary, userMessages: string[]): string[] {
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const found = regionsInMessage(vocabulary, userMessages[i]);
    if (found.length > 0) return found;
  }
  return [];
}
