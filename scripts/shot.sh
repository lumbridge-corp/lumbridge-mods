#!/usr/bin/env bash
# Saves the live window to ~/shots/YYYY-MM/lumbridge-<label>-<time>.png and prints the path.
# Optional crop for reading details: shot.sh fleet 0,0,330,1337  (x,y,w,h in px)
set -euo pipefail
label=${1:-shot}
dir=$HOME/shots/$(date +%Y-%m); mkdir -p "$dir"
f=$dir/lumbridge-$label-$(date +%H%M%S).png
lumbridge-app shot "$f" >/dev/null
if [ -n "${2:-}" ]; then
  python3 - "$f" "$2" <<'PY'
import sys
from PIL import Image
f, box = sys.argv[1], [int(v) for v in sys.argv[2].split(",")]
x, y, w, h = box
Image.open(f).crop((x, y, x + w, y + h)).save(f)
PY
fi
echo "$f"
