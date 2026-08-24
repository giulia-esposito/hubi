import { spawn } from "node:child_process";
import readline from "node:readline";

export interface ReasoningResult {
  ok: boolean;
  text: string;
  mode: "stream";
  durationMs: number;
  error?: string;
}

export interface ReasoningOptions {
  timeoutMs?: number;
  onDelta?: (text: string) => void;
}

// Confirmed in Phase 0 (Prototype_Plan.md Section 3.2): these three flags are
// what actually produce the CLI's own `tools:[]` / `mcp_servers:[]` init event --
// the technical proof of isolation, not the model's self-report.
const ISOLATION_ARGS = ["--tools", "", "--strict-mcp-config", "--setting-sources", ""];

/**
 * ReasoningEngine.generate() implemented against Claude Code, per
 * Prototype_Plan.md Section 3.6's adapter interface. Phase 0 confirmed real
 * incremental streaming works (Section 3.3/3.8), so this always requests
 * stream-json and forwards each text delta to `onDelta` as it arrives --
 * this is the "stream" mode, not the progressive-reveal fallback.
 */
export function askClaudeCode(
  preparedPrompt: string,
  systemPrompt: string,
  opts: ReasoningOptions = {}
): Promise<ReasoningResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p", preparedPrompt,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--system-prompt", systemPrompt,
        ...ISOLATION_ARGS,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let finalText = "";
    let sawSuccess = false;
    let stderrBuf = "";
    let settled = false;

    const finish = (result: ReasoningResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, text: finalText, mode: "stream", durationMs: Date.now() - start, error: "timeout" });
    }, timeoutMs);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      // Real CLI schema: the incremental delta is nested under event.event.delta.text
      // (a stream_event envelope wraps the actual Anthropic streaming event) -- see
      // Prototype_Plan.md Section 3.3 for why a shallower path silently finds nothing.
      if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
        const delta = event.event.delta?.text;
        if (delta && opts.onDelta) opts.onDelta(delta);
      }
      if (event.type === "result") {
        sawSuccess = event.subtype === "success" && event.is_error === false;
        finalText = typeof event.result === "string" ? event.result : finalText;
      }
    });

    child.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    child.on("close", () => {
      finish({
        ok: sawSuccess,
        text: finalText,
        mode: "stream",
        durationMs: Date.now() - start,
        error: sawSuccess ? undefined : stderrBuf.trim() || "reasoning engine returned a non-success result",
      });
    });

    child.on("error", (err) => {
      finish({ ok: false, text: "", mode: "stream", durationMs: Date.now() - start, error: String(err) });
    });
  });
}
