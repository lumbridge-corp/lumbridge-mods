#!/bin/sh
# Claude Code hook (SessionStart + SessionEnd): keeps "which conversation is in this
# terminal" as labels on the lumbridge-core terminal, so lumbridge-restore can resume it after a
# reboot. See the repository README (Restore). Installed by hand into ~/.claude/settings.json.
#
# SessionStart: claude.session, claude.cwd, claude.flags (allow-listed launch flags).
# SessionEnd, only when the person left on purpose: removes them, so a Claude you quit isn't
# offered back. Any other end (a reboot's SIGTERM, /clear) leaves them.
#
# Runs for every Claude on the box: always exits 0, prints nothing, never blocks Claude.
[ -n "${LBC_TERMINAL_ID:-}" ] || exit 0
input=$(cat 2>/dev/null) || exit 0

# Walk up from the hook, now: Claude's hook shell is gone once we've returned, so this can't
# be backgrounded. The nearest claude is ours. A second claude above it, or a one-shot (-p),
# means we're a helper inside a pane's real Claude: that terminal's label isn't ours.
pid=$PPID own="" hops=0
while [ "${pid:-0}" -gt 1 ] && [ $hops -lt 12 ]; do
  line=$(ps -o ppid=,args= -p "$pid" 2>/dev/null) || break
  set -- $line
  parent=${1:-0}
  [ $# -gt 0 ] && shift
  case "$(basename -- "${1:-}")|$(basename -- "${2:-}")" in
    claude\|*|node\|claude|node\|cli.js)
      [ -z "$own" ] && own=$* || exit 0 ;;
  esac
  pid=$parent
  hops=$((hops + 1))
done
[ -n "$own" ] || exit 0

flags=""
set -- $own
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--print) exit 0 ;;
    --dangerously-skip-permissions) flags="$flags $1" ;;
    --model|--permission-mode|--setting-sources|--effort|--add-dir|--agent)
      [ $# -gt 1 ] && flags="$flags $1 $2" && shift ;;
  esac
  shift
done

(
  command -v jq >/dev/null && command -v lbc >/dev/null || exit 0
  event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
  session=$(printf '%s' "$input" | jq -r '.session_id // empty')
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
  reason=$(printf '%s' "$input" | jq -r '.reason // empty')

  case "$event" in
    SessionStart)
      [ -n "$session" ] || exit 0
      timeout 3 lbc label "$LBC_TERMINAL_ID" "claude.session=$session" "claude.cwd=$cwd" "claude.flags=${flags# }" ;;
    SessionEnd)
      case "$reason" in
        prompt_input_exit|logout)
          timeout 3 lbc label "$LBC_TERMINAL_ID" claude.session= claude.cwd= claude.flags= ;;
      esac ;;
  esac
) </dev/null >/dev/null 2>&1 &
exit 0
