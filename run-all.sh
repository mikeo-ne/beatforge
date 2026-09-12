#!/bin/sh
# Full BEATFORGE test suite.
#   Needs node. The Python engine benchmark additionally needs numpy + scipy,
#   and skips cleanly (exit 0) when the reference audio isn't present.
#
# Every test's own exit code is what decides the result: nothing is piped,
# truncated, or stderr-suppressed, so a failure can never be mistaken for a pass.
set -e
cd "$(dirname "$0")"

python3 extract-app.py

printf '\n== syntax ==\n'
node --check ../build/app.js && echo "  app.js parses"

for t in genre-rhythms genre-export wav-render mp3-path browser-engine; do
  printf '\n== %s ==\n' "$t"
  node "$t.cjs"
done

printf '\n== python engine ==\n'
cd ..
python3 bench.py

printf '\nAll suites passed.\n'
