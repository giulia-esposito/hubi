/**
 * Which Content Registry record a file is, decided before governance runs.
 *
 * The identifier can come from two places: the "Content ID" row inside the document, and the "[RKC-000NNN]" label
 * in the file or folder name (the Drive/export convention). Governance trusts the registry, so the file must reach it
 * under the right identifier:
 *
 *   both agree, or only one exists   that identifier (a document with no Content ID row used to fall back to its
 *                                    title, which made the registry miss it: an Ineligible file was then served as
 *                                    "unregistered")
 *   they disagree                    an identity conflict. It is never resolved silently: the document is excluded
 *                                    and reported (lib/governance/governance.ts)
 *   neither                          the title, as before (an unregistered file)
 */

const PATH_ID = /\[(RKC-\d{6})\]/i;

export interface ResolvedIdentity {
  id: string;
  source: "document" | "path" | "title";
  /** Set when the document and the file name name different registry records. */
  conflict?: { documentId: string; pathId: string };
}

/** The registry identifier named by the file's path (file name first, then its folders, nearest first), if any. */
export function pathRegistryId(relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/).reverse();
  for (const part of parts) {
    const m = PATH_ID.exec(part);
    if (m) return m[1].toUpperCase();
  }
  return undefined;
}

export function resolveIdentity(documentId: string, fallbackTitle: string, relativePath: string, documentHasContentId: boolean): ResolvedIdentity {
  const fromPath = pathRegistryId(relativePath);
  const fromDocument = documentHasContentId ? documentId.trim() : undefined;
  if (fromDocument && fromPath && fromDocument.toUpperCase() !== fromPath) {
    // A distinct id, so the excluded entry cannot be mistaken for (or merged with) the record the document wrongly claims.
    return { id: `${fromPath}~identity-conflict`, source: "path", conflict: { documentId: fromDocument, pathId: fromPath } };
  }
  if (fromDocument) return { id: fromDocument, source: "document" };
  if (fromPath) return { id: fromPath, source: "path" };
  return { id: fallbackTitle, source: "title" };
}
