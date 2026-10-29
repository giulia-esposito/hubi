/**
 * The Content Registry as data (Finding #002 / #003 governance).
 *
 * The canonical registry is the "RKC | Revenue Knowledge Center - Content
 * Registry" sheet. Hubi does not read it at request time. A reviewed export is
 * turned into a snapshot (scripts/sync-registry.ts) that is compiled into the
 * code, so the gate is versioned, auditable, and cannot fail open because a
 * file or a network call is missing at runtime.
 *
 * What the registry decides here: whether a document may reach retrieval at
 * all (AI Eligibility and Content Status), and what caveat travels with a
 * restricted document. Everything else the registry holds (owners, review
 * dates, backups) is out of scope and deliberately not carried.
 */

export type AiEligibility = "Eligible" | "Eligible with Restrictions" | "Not Eligible" | "Pending Assessment" | "Unassessed";

export interface RegistryEntry {
  contentId: string;
  aiEligibility: AiEligibility;
  /** Active, Archived, Deprecated... as the registry states it ("" when blank). */
  contentStatus: string;
  /** The registry's Region / Country value, raw. */
  region: string;
  /** Issues / Risks flags (Outdated Content, Broken Link, Incomplete Content...). */
  risks: string[];
  /** The registry note, kept only for Eligible with Restrictions entries: it is the caveat users must see. */
  restriction?: string;
  /** Training, Wiki Page, Newsletter, Coaching Session, Deck, Challenge...: what kind of source it is ("" when blank). */
  contentType: string;
  /** The registry's Collection (for example "Trending This Week"), which identifies a source family more reliably than the type. */
  collection: string;
  /** Who the registry says may see it: "Revenue – All", "Revenue – Specific Function", "Revenue – Leaders Only"... ("" when blank). */
  accessLevel: string;
  /** Source Platform Modified Date, raw as the sheet writes it (day/month/year, 2- or 4-digit year); "" when blank. */
  sourceModified: string;
}

export interface RegistrySnapshot {
  /** Where the snapshot was read, for audit. */
  source: string;
  /** Registry revision or modified time the export was taken from. */
  sourceRevision: string;
  /** Date the snapshot was generated (YYYY-MM-DD). */
  syncedAt: string;
  entries: RegistryEntry[];
}

/** Statuses that take a document out of use regardless of its AI Eligibility. */
export const RETIRED_STATUSES: readonly string[] = ["archived", "deprecated"];

const ELIGIBILITY_BY_NORMALIZED: Record<string, AiEligibility> = {
  eligible: "Eligible",
  "eligible with restrictions": "Eligible with Restrictions",
  "not eligible": "Not Eligible",
  "pending assessment": "Pending Assessment",
};

/** A blank or unrecognized value is "Unassessed": it never passes the gate. */
export function normalizeEligibility(raw: string | undefined): AiEligibility {
  return ELIGIBILITY_BY_NORMALIZED[(raw ?? "").trim().toLowerCase()] ?? "Unassessed";
}

export interface GateDecision {
  allowed: boolean;
  /** Why the document is out (empty when allowed). */
  reason: string;
}

/** The pass/fail rule: AI-eligible (with or without restrictions) and not retired. Anything else is out. */
export function decideEntry(entry: RegistryEntry): GateDecision {
  if (entry.aiEligibility !== "Eligible" && entry.aiEligibility !== "Eligible with Restrictions") {
    return { allowed: false, reason: `AI Eligibility: ${entry.aiEligibility}` };
  }
  if (RETIRED_STATUSES.includes(entry.contentStatus.trim().toLowerCase())) {
    return { allowed: false, reason: `Content Status: ${entry.contentStatus}` };
  }
  return { allowed: true, reason: "" };
}

const ID_PATTERN = /^RKC-\d{3,}$/;

/** True for an identifier in the registry's own format. */
export function isRegistryId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

/** Header names as the registry sheet writes them ("Region / Country\n(multi-select)") reduced to a stable key. */
function headerKey(cell: string): string {
  return cell
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const REQUIRED_COLUMNS = ["content id", "ai eligibility", "content status"] as const;

export interface ParsedRegistry {
  entries: RegistryEntry[];
  warnings: string[];
}

/**
 * Reads a registry export (the full Content Registry tab, or the trimmed
 * governance columns) into entries. The header row is found by its "Content ID"
 * cell, so the sheet's group-header row above it is ignored. Rows without an
 * RKC identifier are skipped; duplicate identifiers are an error, because two
 * answers for one document cannot both be right.
 */
export function parseRegistryCsv(text: string): ParsedRegistry {
  const rows = parseCsv(text);
  const headerAt = rows.findIndex((r) => headerKey(r[0] ?? "") === "content id");
  if (headerAt < 0) throw new Error('Registry export has no "Content ID" header row.');
  const columns = new Map<string, number>();
  rows[headerAt].forEach((cell, i) => {
    const key = headerKey(cell);
    if (key && !columns.has(key)) columns.set(key, i);
  });
  for (const required of REQUIRED_COLUMNS) {
    if (!columns.has(required)) throw new Error(`Registry export is missing the "${required}" column.`);
  }
  const col = (row: string[], key: string) => (columns.has(key) ? (row[columns.get(key)!] ?? "").trim() : "");

  const entries: RegistryEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(headerAt + 1)) {
    const contentId = col(row, "content id");
    if (!isRegistryId(contentId)) {
      if (contentId) warnings.push(`skipped a row with an unrecognized Content ID: "${contentId}"`);
      continue;
    }
    if (seen.has(contentId)) throw new Error(`Registry export lists ${contentId} more than once.`);
    seen.add(contentId);

    const aiEligibility = normalizeEligibility(col(row, "ai eligibility"));
    if (aiEligibility === "Unassessed") warnings.push(`${contentId}: AI Eligibility is blank or unrecognized ("${col(row, "ai eligibility")}"), so it is treated as Unassessed and excluded`);
    const note = col(row, "notes");
    const risks = col(row, "issues / risks")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    entries.push({
      contentId,
      aiEligibility,
      contentStatus: col(row, "content status"),
      region: col(row, "region / country") || col(row, "region"),
      risks,
      contentType: col(row, "content type"),
      collection: col(row, "collection"),
      accessLevel: col(row, "access level"),
      sourceModified: col(row, "source platform modified date"),
      ...(aiEligibility === "Eligible with Restrictions" && note ? { restriction: note } : {}),
    });
  }
  if (entries.length === 0) throw new Error("Registry export contains no RKC entries.");
  return { entries, warnings };
}

/** Structural checks the snapshot must satisfy before it can be compiled in. */
export function validateSnapshot(snapshot: RegistrySnapshot): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.syncedAt)) problems.push("syncedAt is not YYYY-MM-DD");
  if (!snapshot.source.trim()) problems.push("source is empty");
  if (snapshot.entries.length === 0) problems.push("no entries");
  const seen = new Set<string>();
  for (const e of snapshot.entries) {
    if (!isRegistryId(e.contentId)) problems.push(`bad Content ID ${e.contentId}`);
    if (seen.has(e.contentId)) problems.push(`duplicate ${e.contentId}`);
    seen.add(e.contentId);
  }
  return problems;
}
