#!/bin/sh
# Full BEATFORGE test suite.
#   Needs node + python3. Optional extras each skip cleanly (exit 0) when absent:
#     jsdom (npm install)        -> tests/dom.cjs, the real-page UI test
#     numpy + scipy (pip -r)     -> tests/server-engine.py and bench.py
#     reference audio            -> bench.py ($BEATFORGE_REF, not committed)
#
# Every test's own exit code is what decides the result: nothing is piped,
# truncated, or stderr-suppressed, so a failure can never be mistaken for a pass.
#
# Run from anywhere:  sh tests/run-all.sh
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

for bin in node python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "run-all.sh: '$bin' is required but not on PATH"; exit 1; }
done

python3 "$HERE/extract-app.py"

printf '\n== syntax ==\n'
node --check "$REPO/build/app.js" && echo "  app.js parses"
python3 "$HERE/check-inline.py"

# tests read build/app.js relative to their own directory
cd "$HERE"
for t in genre-rhythms genre-export midi-parity kit-humanize wav-render mp3-path browser-engine; do
  printf '\n== %s ==\n' "$t"
  node "$t.cjs"
done

printf '\n== dom / ui ==\n'
node "$HERE/dom.cjs"

printf '\n== python engine ==\n'
cd "$REPO"
python3 tests/server-engine.py

printf '\n== accuracy benchmark ==\n'
python3 bench.py

printf '\nAll suites passed.\n'
