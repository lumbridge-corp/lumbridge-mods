#!/usr/bin/env bash
# Scaffolds mods/lumbridge-<name> with the kit and a passing check (and a spec stub when
# there is a specs/ folder).
#   scripts/new-mod.sh clock "Clock"
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
short=${1:?usage: new-mod.sh <short-name> [Title]}
title=${2:-$short}
name=lumbridge-$short
dir=$root/mods/$name
[ -e "$dir" ] && { echo "$name exists" >&2; exit 1; }
mkdir -p "$dir/_kit"
cp "$root/lib/kit.js" "$dir/_kit/kit.js"
printf '{ "place": "none", "title": "%s" }\n' "$title" > "$dir/mod.json"
cat > "$dir/main.js" <<JS
// $title: a Lumbridge mod. See the repository README (Write your own).
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "lumbridge";
import { header } from "./_kit/kit.js";

export default class $(echo "$short" | sed -E 's/(^|-)([a-z])/\U\2/g') extends View {
  init(_props, _cx) {}

  render(_cx) {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(header(t, "$title"))
      .child(div().px(16).text_color(t.dim).child("Not built yet."));
  }
}
JS
if [ -d "$root/specs" ] && [ ! -e "$root/specs/$short.md" ]; then
  printf '# %s (`%s`)\n\nStatus: idea\n\n## What it is for\n\n## Data\n\n## UI\n\n## Done when\n' "$title" "$name" > "$root/specs/$short.md"
fi
"$root/scripts/check.sh" "$name"
