#!/bin/sh
# BookTranslator — one-command launcher for macOS / Linux.
# Runs from whatever folder this file lives in. Requires Node.js (https://nodejs.org).
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed — get it from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
( sleep 2; command -v open >/dev/null 2>&1 && open "http://localhost:4319" || xdg-open "http://localhost:4319" 2>/dev/null ) &
echo "BookTranslator starting at http://localhost:4319  (Ctrl-C to stop)"
node server/index.js
