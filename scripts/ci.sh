#!/usr/bin/env bash
# What CI runs (the repository's CI workflow; .github/workflows/ci.yml sets LUMBRIDGE_MODS_NO_APP=1), and what to run before a pull request: scripts/ci.sh
#  - scripts/check.sh with a throwaway LUMBRIDGE_APP_HOME (names, JSON, kit copies, `lumbridge-app check` per mod)
#  - the logic tests, tests/*.test.mjs
# Needs lumbridge-app and node on PATH. No window, no Lumbridge Core, no real ~/.config/lumbridge-app.
# LUMBRIDGE_MODS_NO_APP=1 skips the `lumbridge-app check` step (CI on a machine without the app).
set -uo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d "${TMPDIR:-/tmp}/lci.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/app"
# The shipped main layout of the lumbridge-app this runs against, so check.sh's layout-drift warning still works
# (LUMBRIDGE_CI_TOOLS: a folder holding lumbridge-app/current/home; optional).
ref="${LUMBRIDGE_CI_TOOLS:-}/lumbridge-app/current/home"
if [ -n "${LUMBRIDGE_CI_TOOLS:-}" ] && [ -d "$ref" ]; then cp -r "$ref/." "$T/app/"; fi
fail=0
if [ "${LUMBRIDGE_MODS_NO_APP:-}" = 1 ]; then echo "skip lumbridge-app (LUMBRIDGE_MODS_NO_APP=1)"
else lumbridge-app --version || { echo "FAIL lumbridge-app is not on PATH"; exit 1; }; fi
HOME="$T/home" LUMBRIDGE_APP_HOME="$T/app" scripts/check.sh || fail=1
node --version
for t in tests/*.test.mjs; do
  [ -e "$t" ] || continue
  if HOME="$T/home" node "$t"; then echo "ok   $t"; else echo "FAIL $t"; fail=1; fi
done
exit $fail
