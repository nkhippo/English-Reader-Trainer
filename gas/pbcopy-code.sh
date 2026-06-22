#!/bin/bash
# Copy gas/Code.gs to macOS clipboard for pasting into Apps Script editor.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
FILE="$ROOT/Code.gs"
LINES=$(wc -l < "$FILE" | tr -d ' ')
BYTES=$(wc -c < "$FILE" | tr -d ' ')
pbcopy < "$FILE"
echo "Copied $LINES lines ($BYTES bytes) to clipboard."
echo "In GAS: open Code.gs → click editor → Cmd+A → Delete → Cmd+V → wait → Cmd+S"
echo "Verify: search repairPassageTargetChunkSpans_ (expect hits near line 2156)."
