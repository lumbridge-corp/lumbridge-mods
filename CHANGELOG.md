# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-13

The first release of Lumbridge Mods.

- `lumbridge-favorites`: star a terminal to move it, still running, into one Favorites space, and back.
  The space lives on the hub (`lumbridge-mods.json`, default: this computer). `ctrl-alt-s` stars the focused terminal.
- `lumbridge-restore` and `hooks/claude-session-label.sh`: resume Claude Code conversations in their panes after a
  reboot, on request. `ctrl-alt-r`.
- `lumbridge-mail`: Lumbridge Mail in a pane through `lbmail --json --agent`. `ctrl-alt-m`.
- `lib/kit.js`, the shared helpers, with `hubMachine()` read from settings.
- `scripts/`: check, install (copies; merges keys and programs, never replaces them), new-mod, sync-kit,
  derive-layout, CI, and `scrub-check`.
