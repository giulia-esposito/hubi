#!/usr/bin/env bash
# Runs the two offline Semgrep passes of the wh-infosec-sast-review skill on a Linux machine
# (Semgrep does not run on native Windows) and writes a triage-ready summary.
#
#   bash semgrep-scan.sh <rules_dir> <source_dir> [out_dir]
#
# rules_dir  the skill's rules folder, containing custom/ and registry-cache/
# source_dir the unpacked Hubi source (git archive output: no node_modules, no corpus)
# Needs: python3 with pip (for semgrep) and node 20+ (for the summary). No network is needed
# by the scan itself; pip needs it once to install Semgrep.
set -euo pipefail
RULES="${1:?rules dir}"; SRC="${2:?source dir}"; OUT="${3:-./sast_out}"
mkdir -p "$OUT"
command -v semgrep >/dev/null || python3 -m pip install --user semgrep >/dev/null
export PATH="$HOME/.local/bin:$PATH"
semgrep --version

CFG=()
while IFS= read -r -d '' f; do CFG+=(--config "$f"); done < <(find "$RULES/registry-cache" -maxdepth 1 -type f \( -name '*.json' -o -name '*.yaml' -o -name '*.yml' \) -print0)
echo "registry packs: $((${#CFG[@]} / 2))"

semgrep --config "$RULES/custom" --metrics=off --disable-version-check --quiet --json-output="$OUT/custom.json" "$SRC" || true
semgrep "${CFG[@]}" --metrics=off --disable-version-check --quiet --json-output="$OUT/registry.json" "$SRC" || true

node "$(dirname "$0")/summarize.mjs" "$OUT/custom.json" "$OUT/registry.json" "$OUT/summary.json" | tee "$OUT/summary.txt"
echo "Send back: $OUT/summary.json (small). Keep custom.json and registry.json for the audit trail."
