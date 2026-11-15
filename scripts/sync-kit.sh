#!/usr/bin/env bash
# Copies lib/kit.js into every mod as mods/<name>/_kit/kit.js.
# lumbridge-app refuses imports from outside a mod's own folder, so each mod
# carries its own copy. Edit lib/kit.js, run this, commit both.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
for mod in "$root"/mods/*/; do
  mkdir -p "$mod/_kit"
  cp "$root/lib/kit.js" "$mod/_kit/kit.js"
done
echo "kit synced into $(ls -d "$root"/mods/*/ | wc -l) mod(s)"
