import { loadContent } from "../ingestion/loadContent.ts";
import type { RetrievalIndex } from "../retrieval/index.ts";
import { buildGovernedIndex } from "./governedIndex.ts";
import type { ExcludedContent, GovernanceReport } from "../governance/governance.ts";
import { emitTelemetry } from "./telemetry.ts";

export interface KnowledgeBase {
  index: RetrievalIndex;
  documentCount: number;
  chunkCount: number;
  /** Documents removed by the AI Eligibility gate before indexing (never retrievable). */
  excluded: ExcludedContent[];
  /** What the Content Registry did to this corpus: exclusions, restrictions, unregistered files, drift. */
  governance: GovernanceReport;
}

let cached: Promise<KnowledgeBase> | null = null;
let state: KnowledgeBaseState = { status: "not-started" };

export type KnowledgeBaseState =
  | { status: "not-started" }
  | { status: "loading"; since: string }
  | { status: "ready"; since: string; documents: number; chunks: number }
  | { status: "failed"; since: string; error: string };

/** Readiness for /api/health: reading it never starts (or waits for) ingestion. */
export function knowledgeBaseState(): KnowledgeBaseState {
  return state;
}

/**
 * Ingests Content Repository and builds the retrieval index exactly once per
 * server process (a module-level lazy singleton) rather than per-request.
 * scripts/ask.ts re-ingests on every invocation because it's a short-lived
 * CLI process; a long-lived Next.js server must not repeat that ~1-2s of
 * work on every chat request.
 *
 * Async since resolveContentRepositoryPath() may need to download the
 * Content Repository from GCS on first call (see lib/ingestion/
 * contentSource.ts) -- local development is unaffected: with
 * HUBI_CONTENT_SOURCE unset, path resolution is synchronous in effect and
 * this simply awaits a value that was already available.
 */
/** Test seam: route-level tests supply an in-memory knowledge base. Never called by application code. */
export function setKnowledgeBaseForTests(kb: KnowledgeBase | null): void {
  cached = kb ? Promise.resolve(kb) : null;
  state = kb ? { status: "ready", since: new Date().toISOString(), documents: kb.documentCount, chunks: kb.chunkCount } : { status: "not-started" };
}

export async function getKnowledgeBase(): Promise<KnowledgeBase> {
  if (!cached) {
    state = { status: "loading", since: new Date().toISOString() };
    cached = (async () => {
      const { documentCount, chunks } = await loadContent();
      const { index, excluded, report } = buildGovernedIndex(chunks);
      emitTelemetry("governance", {
        type: "governance",
        timestamp: new Date().toISOString(),
        registry: report.registry,
        chunksIn: report.chunksIn,
        chunksKept: report.chunksKept,
        excluded: report.excluded,
        restricted: report.restricted,
        unregistered: report.unregistered,
        drift: report.drift,
      });
      state = { status: "ready", since: new Date().toISOString(), documents: documentCount, chunks: report.chunksKept };
      return {
        index,
        documentCount,
        chunkCount: chunks.length,
        excluded,
        governance: report,
      };
    })();
    // A transient failure (e.g. a momentary GCS download error) must not
    // permanently wedge the process into a rejected singleton -- clear the
    // cache so the next request retries ingestion from scratch.
    cached.catch((err) => {
      state = { status: "failed", since: new Date().toISOString(), error: String((err as Error)?.message ?? err).slice(0, 300) };
      cached = null;
    });
  }
  return cached;
}
