import type { Chunk } from "../ingestion/chunk.ts";

/**
 * What kind of source a chunk comes from and how recent it is (docs/source-selection-design.md). Labels only:
 * nothing here ranks, filters or penalises a source. The model sees the facts and the source-governance rule decides.
 */

export type DateBasis = "document" | "registry";

export interface SourceDate {
  /** ISO date, YYYY-MM-DD. */
  iso: string;
  basis: DateBasis;
}

export interface SourceFacts {
  /** Registry Content Type, "" when unknown (unregistered files have none). */
  contentType: string;
  collection: string;
  date?: SourceDate;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Reads the three date shapes the corpus uses: "2026-04-16 14:55:28 UTC" and "Jul 4, 2024" inside documents, and the
 * registry's day/month/year ("4/7/26", "16/04/2026"). Anything else, or a day/month/year with month above 12, is null:
 * an ambiguous date is left out rather than guessed.
 */
export function parseSourceDate(raw: string | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|T)/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = text.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return month > 0 ? iso(+m[3], month, +m[2]) : null;
  }
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}

/** "2026-07-14" -> "14 Jul 2026". */
export function formatSourceDate(isoDate: string): string {
  const [y, mo, d] = isoDate.split("-").map(Number);
  return `${d} ${MONTHS[mo - 1][0].toUpperCase()}${MONTHS[mo - 1].slice(1)} ${y}`;
}

/** The document's own last-updated (else creation) date first, then the registry's Source Platform Modified Date. */
export function sourceFactsOf(chunk: Chunk): SourceFacts {
  const inFile = parseSourceDate(chunk.documentDate);
  const inRegistry = parseSourceDate(chunk.governance?.sourceModified);
  const date: SourceDate | undefined = inFile ? { iso: inFile, basis: "document" } : inRegistry ? { iso: inRegistry, basis: "registry" } : undefined;
  return { contentType: chunk.governance?.contentType ?? "", collection: chunk.governance?.collection ?? "", date };
}

/** The line shown under a source header, or "" when nothing is known: "Type: Newsletter (Trending This Week) | Updated: 14 Jul 2026". */
export function sourceFactsLine(chunk: Chunk): string {
  const f = sourceFactsOf(chunk);
  const parts: string[] = [];
  if (f.contentType) parts.push(`Type: ${f.contentType}${f.collection ? ` (${f.collection})` : ""}`);
  if (f.date) parts.push(`Updated: ${formatSourceDate(f.date.iso)}`);
  return parts.join(" | ");
}

/** The fields logged per source so pilot traffic shows which source kinds and ages the model was given. */
export function sourceFactsLog(chunk: Chunk): { contentType?: string; collection?: string; updated?: string; updatedBasis?: DateBasis } {
  const f = sourceFactsOf(chunk);
  return {
    contentType: f.contentType || undefined,
    collection: f.collection || undefined,
    updated: f.date?.iso,
    updatedBasis: f.date?.basis,
  };
}
