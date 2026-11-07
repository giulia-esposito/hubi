/**
 * What a tester sees for the sources of an answer. The server sends one entry per retrieved passage with full metadata
 * (it stays in the logs); the screen shows one row per document, with a readable title and the sections used.
 * Plain data and no browser dependencies, so each surface (the web app today, Google Chat later) can reuse it.
 */

import { OUTDATED_CAVEAT } from "../governance/registry.ts";

export interface SourceInput {
  documentTitle: string;
  heading: string | null;
  citationUrl: string | null;
  /** The Content Registry's caveat for an Eligible with Restrictions source. */
  restriction?: string;
}

export interface DisplaySource {
  title: string;
  url: string | null;
  /** Up to MAX_SECTIONS distinct sections of the document that the answer used. */
  sections: string[];
  /** A registry caveat specific to this source (not the standard outdated one, which is `outdated`). */
  restriction?: string;
  /** The registry flags the source as possibly outdated: shown once for the whole answer, and as a flag on the source. */
  outdated?: boolean;
}

const MAX_SECTIONS = 3;

/** File-name leftovers that mean nothing to a reader: underscores as separators, "DO NOT EDIT", a registry id prefix. */
export function humanizeTitle(raw: string): string {
  let t = String(raw ?? "");
  t = t.replace(/^\s*\[?RKC-\d+\]?\s*[-:]?\s*/i, "");
  t = t.replace(/[\[(]?\s*do not edit\s*[\])]?/gi, " ");
  t = t.replace(/\s\|\s/g, " · ");
  t = t.replace(/\[([^\]]+)\]/g, "$1");
  t = t.replace(/\s*_\s*/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/[\s·|:-]+$/, "").trim();
  return t || String(raw ?? "").trim();
}

/** One row per document, in the order the answer's sources were ranked. */
export function groupSources(sources: SourceInput[]): DisplaySource[] {
  const byDoc = new Map<string, DisplaySource>();
  for (const s of sources) {
    const key = s.documentTitle;
    let row = byDoc.get(key);
    if (!row) {
      row = { title: humanizeTitle(s.documentTitle), url: s.citationUrl, sections: [] };
      byDoc.set(key, row);
    }
    if (!row.url && s.citationUrl) row.url = s.citationUrl;
    const heading = s.heading?.replace(/\s+/g, " ").trim();
    if (heading && heading !== s.documentTitle && !row.sections.includes(heading) && row.sections.length < MAX_SECTIONS) row.sections.push(heading);
    if (s.restriction === OUTDATED_CAVEAT) row.outdated = true;
    else if (s.restriction && !row.restriction) row.restriction = s.restriction;
  }
  return [...byDoc.values()];
}
