import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathRegistryId, resolveIdentity } from "../lib/ingestion/identity.ts";
import { applyGovernance } from "../lib/governance/governance.ts";
import type { Chunk } from "../lib/ingestion/chunk.ts";
import type { RegistryEntry, RegistrySnapshot } from "../lib/governance/registry.ts";

describe("document identity", () => {
  test("the id in the file or folder name is read", () => {
    assert.equal(pathRegistryId("[RKC-000069] Payroll Basics Training - Wiki.docx"), "RKC-000069");
    assert.equal(pathRegistryId("Knowledge Center/[RKC-000027] Some doc/export.docx"), "RKC-000027");
    assert.equal(pathRegistryId("PMM _ Slide Library.pptx"), undefined);
    assert.equal(pathRegistryId("[RKC-0000010] malformed.docx"), undefined, "only six-digit ids are registry ids");
  });
  test("a document with no Content ID row takes the id from its file name instead of falling back to its title", () => {
    assert.deepEqual(resolveIdentity("Payroll Basics Training", "Payroll Basics Training", "[RKC-000069] Payroll Basics Training.docx", false), { id: "RKC-000069", source: "path" });
  });
  test("agreeing ids, a document-only id and a title-only file keep their id", () => {
    assert.equal(resolveIdentity("RKC-000006", "t", "[RKC-000006] x.docx", true).id, "RKC-000006");
    assert.equal(resolveIdentity("RKC-000006", "t", "x.docx", true).id, "RKC-000006");
    assert.deepEqual(resolveIdentity("Golden Pitch", "Golden Pitch", "Golden Pitch.pptx", false), { id: "Golden Pitch", source: "title" });
  });
  test("disagreeing ids are a conflict, never resolved silently", () => {
    const r = resolveIdentity("RKC-000076", "t", "[RKC-000075] x.docx", true);
    assert.deepEqual(r.conflict, { documentId: "RKC-000076", pathId: "RKC-000075" });
    assert.notEqual(r.id, "RKC-000076");
  });
});

const chunk = (documentId: string, extra: Partial<Chunk> = {}): Chunk => ({ id: `${documentId}::s0`, documentId, documentTitle: documentId, heading: null, text: "text", citationUrl: null, citationUrlType: null, ...extra });
const entry = (contentId: string, aiEligibility: RegistryEntry['aiEligibility']): RegistryEntry => ({ contentId, aiEligibility, contentStatus: 'Active', region: 'Global', risks: [], contentType: 'Training', collection: '', accessLevel: 'Revenue – All', sourceModified: '' });
const registry: RegistrySnapshot = { source: 'test', sourceRevision: '1', syncedAt: '2026-11-05', entries: [entry('RKC-000069', 'Not Eligible'), entry('RKC-000076', 'Eligible')] };

describe("governance and identity", () => {
  test("a Not Eligible file with no Content ID row is excluded once its id comes from the file name", () => {
    const out = applyGovernance([chunk("RKC-000069")], { registry });
    assert.equal(out.chunks.length, 0);
    assert.equal(out.excluded[0].contentId, "RKC-000069");
  });
  test("an identity conflict is excluded and reported, and does not disturb the record it wrongly names", () => {
    const conflicted = chunk("RKC-000075~identity-conflict", { identityConflict: { documentId: "RKC-000076", pathId: "RKC-000075" } });
    const out = applyGovernance([conflicted, chunk("RKC-000076")], { registry });
    assert.deepEqual(out.chunks.map((c) => c.documentId), ["RKC-000076"]);
    assert.equal(out.excluded.length, 1);
    assert.match(out.excluded[0].reason, /RKC-000076.*RKC-000075/);
  });
});
