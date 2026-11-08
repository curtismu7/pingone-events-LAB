#!/bin/bash
# Checks that the vendored web/src/standalone-ui.css is byte-identical to the family's canonical copy.
# STANDALONE_UI_CANONICAL overrides where the canonical copy is.
# Without the canonical (for example in CI) the copy is checked against scripts/standalone-ui.sha256, the hash of the
# canonical copy this app was last re-vendored from, so an edited vendored copy fails CI. A canonical copy that has
# moved on is only visible where it exists: run this script on a Mac that has AI-DEMO-Standalone.
# Usage: scripts/check-ui-standard.sh [--pin]   (--pin writes the hash after you re-vendor)
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
canonical="${STANDALONE_UI_CANONICAL:-$HOME/Development/AI-DEMO-Standalone/shared/standalone-ui.css}"
copy="$root/web/src/standalone-ui.css"
pin="$root/scripts/standalone-ui.sha256"
hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
if [ ! -f "$copy" ]; then echo "MISSING web/src/standalone-ui.css"; exit 1; fi
if [ "${1:-}" = "--pin" ]; then
  if [ -f "$canonical" ] && ! cmp -s "$canonical" "$copy"; then echo "DRIFT   re-vendor first: copy differs from $canonical"; exit 1; fi
  hash "$copy" > "$pin"; echo "pinned  $(cat "$pin")"; exit 0
fi
status=0
if [ -f "$canonical" ]; then
  if cmp -s "$canonical" "$copy"; then echo "OK      web/src/standalone-ui.css matches the canonical copy"
  else echo "DRIFT   web/src/standalone-ui.css differs from $canonical"; status=1; fi
else
  echo "skip    canonical standalone-ui.css not found at $canonical (set STANDALONE_UI_CANONICAL)"
fi
if [ -f "$pin" ]; then
  if [ "$(hash "$copy")" = "$(cat "$pin")" ]; then echo "OK      matches the pinned hash"
  else echo "DRIFT   web/src/standalone-ui.css differs from scripts/standalone-ui.sha256 (edited copy, or re-vendored without --pin)"; status=1; fi
else
  echo "MISSING scripts/standalone-ui.sha256 (run scripts/check-ui-standard.sh --pin)"; status=1
fi
exit $status
