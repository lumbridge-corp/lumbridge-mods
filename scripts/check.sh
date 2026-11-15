#!/usr/bin/env bash
# Checks the repo, or only the named mods: scripts/check.sh [lumbridge-mail ...]
#  - names start with lumbridge- (never a shipped mod's name)
#  - mod.json / layouts / config JSON parse
#  - _kit/kit.js matches lib/kit.js
#  - `lumbridge-app check` loads and renders each mod once (no window needed)
# Exits nonzero on the first class of failure, after reporting all of them.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fail=0
say() { printf '%s\n' "$*"; }
bad() { say "FAIL $*"; fail=1; }

if [ $# -gt 0 ]; then mods=(); for n in "$@"; do mods+=("$root/mods/$n"); done
else mods=("$root"/mods/*/); fi

for f in "$root"/layouts/*.json "$root"/config/*.json "$root"/private/layouts/*.json "$root"/private/config/*.json "$root"/private/*.json; do
  [ -e "$f" ] || continue
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" 2>/dev/null || bad "bad JSON: ${f#$root/}"
done

# Warn (not fail) when shipped main changed since layouts/lumbridge.json was derived.
side="$root/layouts/.lumbridge.derived.json"
main="${LUMBRIDGE_APP_HOME:-$HOME/.config/lumbridge-app}/layouts/main.json"
if [ -f "$side" ] && [ -f "$main" ]; then
  want=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["main_sha256"])' "$side")
  have=$(sha256sum "$main" | cut -c1-16)
  [ "$want" = "$have" ] || say "warn shipped main.json changed since lumbridge.json was derived: run scripts/derive-layout.py and review the diff"
fi

for dir in "${mods[@]}"; do
  dir=${dir%/}; name=$(basename "$dir")
  [ -d "$dir" ] || { bad "$name: no such mod"; continue; }
  case $name in lumbridge-*) ;; *) bad "$name: mod names must start with lumbridge-";; esac
  [ -f "$dir/main.js" ] || bad "$name: no main.js"
  [ -f "$dir/mod.json" ] && { python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$dir/mod.json" 2>/dev/null || bad "$name: bad mod.json"; }
  if [ -f "$dir/_kit/kit.js" ]; then
    cmp -s "$root/lib/kit.js" "$dir/_kit/kit.js" || bad "$name: _kit/kit.js differs from lib/kit.js (run scripts/sync-kit.sh)"
  fi
  if [ "${LUMBRIDGE_MODS_NO_APP:-}" = 1 ]; then
    # Syntax only: every .js of the mod, as an ES module.
    syn=""; tmp="${TMPDIR:-/tmp}/lumbridge-check-$$.mjs"
    while IFS= read -r js; do
      cp "$js" "$tmp"; node --check "$tmp" 2>/dev/null || syn="$syn ${js#$dir/}"
    done < <(find "$dir" -name '*.js' -not -name '*.d.ts' | sort)
    rm -f "$tmp"
    if [ -z "$syn" ]; then say "ok   $name (syntax only)"; else bad "$name: does not parse:$syn"; fi
  elif out=$(lumbridge-app check "$dir" 2>&1); then say "ok   $name"; else bad "$name"; say "$out" | sed 's/^/     /'; fi
done
exit $fail
