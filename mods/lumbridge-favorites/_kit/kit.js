// Lumbridge kit: shared helpers for our lumbridge-app mods.
//
// The source of truth is lib/kit.js in this repository. Every mod gets a
// copy at mods/<name>/_kit/kit.js (lumbridge-app refuses imports from outside a
// mod's own folder). Edit lib/, then run scripts/sync-kit.sh; scripts/check.sh
// fails when a copy has drifted.
//
// Import as:  import { Poll, execJSON, colors, header, dot } from "./_kit/kit.js";

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, appHome, spaces, focused, run } from "lumbridge";

export const KIT_VERSION = 5;

// ---------------------------------------------------------------- data

/** Runs a program (here, or `on` a machine) and parses its stdout as JSON.
 *  Throws with the program's stderr when it exits nonzero or prints bad JSON. */
export async function execJSON(command, args = [], options = {}) {
  const r = await exec(command, args, options);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").slice(-1)[0]);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`${command}: not JSON (${String(e.message ?? e).slice(0, 80)})`);
  }
}

/**
 * The hub: the one machine that holds shared things, such as the Favorites space. As an `on`
 * value: null when this window runs ON the hub (or no hub is set), else the hub's lumbridge
 * machine name. Set in <app home>/lumbridge-mods.json:
 *   { "hub": { "machine": "desk", "hostname": "desk" } }
 * `machine` is the name other screens give the hub (`lbc machine ls`); `hostname` is what
 * `hostname` prints on the hub itself (the part before the first dot).
 *   const hub = await hubMachine(); await exec("ls", [], { on: hub });
 */
let hubCache;
export async function hubMachine() {
  if (hubCache !== undefined) return hubCache;
  const hub = (await modsSettings()).hub;
  if (!hub || !hub.machine) return (hubCache = null);
  const r = await exec("hostname");
  hubCache = r.stdout.trim().split(".")[0] === (hub.hostname ?? hub.machine) ? null : hub.machine;
  return hubCache;
}

/** The hub's name for messages: its machine name, or "this computer" when none is set. */
export async function hubName() {
  return (await modsSettings()).hub?.machine ?? "this computer";
}

/** <app home>/lumbridge-mods.json, parsed once; {} when it is missing or not JSON. */
let settingsCache;
export async function modsSettings() {
  if (settingsCache !== undefined) return settingsCache;
  try {
    settingsCache = JSON.parse((await readTextFile(`${appHome()}/lumbridge-mods.json`)) ?? "{}") ?? {};
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

/**
 * A polled value with its error and age, never two fetches at once.
 *
 *   init(_p, cx) { this.status = new Poll(() => execJSON("lbmail", ["--json", "status"]), 15000); this.status.start(cx); }
 *   render()     { this.status.data, this.status.error, this.status.stale() }
 *
 * `start` fetches now, then every `ms`. `refresh(cx)` fetches now (a button).
 * A failed fetch keeps the last good `data`, so a blip doesn't blank a panel.
 * Uses only the cx it is handed: never keeps one (the lumbridge-app rule).
 */
export class Poll {
  constructor(fetcher, ms) {
    this.fetcher = fetcher;
    this.ms = ms;
    this.data = null;
    this.error = null;
    this.at = 0; // ms of the last good fetch
    this.busy = false;
    this.failures = 0;
  }
  start(cx) {
    this.refresh(cx);
    cx.timer.every(this.ms, (cx) => this.refresh(cx));
  }
  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        this.data = await this.fetcher();
        this.error = null;
        this.failures = 0;
        this.at = Date.now();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.failures += 1;
      }
      this.busy = false;
      cx.notify();
    });
  }
  /** No good fetch for three periods: show the data as old. */
  stale() {
    return this.at === 0 || Date.now() - this.at > this.ms * 3;
  }
}

// ---------------------------------------------------------------- actions

/**
 * Shows the tab named `name` in the current space if it's already open, else opens
 * `{mod, name, props}` there. Buttons that open a mod as a tab use this, so a second
 * click doesn't stack a second copy.   openTab("Factories", "lumbridge-factories")
 */
export function openTab(name, mod, props = undefined) {
  const here = focused()?.space;
  const space = spaces().find((s) => s.id === here) ?? spaces().find((s) => s.active);
  const tab = space?.tabs.find((t) => t.named && t.name === name);
  if (tab) run("tab.select", { id: tab.id });
  else run("tab.new", { mod, name, ...(props ? { props } : {}) });
}

/**
 * argv that runs the first of `programs` installed on that machine, else says so and waits,
 * so the space doesn't vanish silently when a program is missing.
 *   run("space.new", { machine, name, argv: firstOf(["htop", "top"]) })
 */
export function firstOf(programs) {
  const tries = programs.map((p) => `command -v ${p.split(" ")[0]} >/dev/null 2>&1 && exec ${p}`).join("; ");
  return ["bash", "-lc", `${tries}; echo "none of: ${programs.join(", ")} is installed here"; exec bash`];
}

// ---------------------------------------------------------------- format

const BARS = "▁▂▃▄▅▆▇█";

/** A text sparkline of `values` (oldest first), last `width` points. */
export function spark(values, width = 24, max = null) {
  const v = (values ?? []).filter((x) => typeof x === "number").slice(-width);
  if (!v.length) return "";
  const hi = max ?? Math.max(...v);
  const lo = max === null ? Math.min(...v) : 0;
  const span = hi - lo || 1;
  return v.map((x) => BARS[Math.max(0, Math.min(7, Math.round(((x - lo) / span) * 7)))]).join("");
}

/** "now", "42s", "5m", "3h", "2d" since a ms timestamp or an ISO string. */
export function ago(when, now = Date.now()) {
  const t = typeof when === "string" ? Date.parse(when) : when;
  if (!t || Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// ---------------------------------------------------------------- look

/**
 * Semantic colors from the theme, so every mod reads the same in light and dark.
 * ok/bad/warn come from the ANSI palette, which every theme defines.
 */
export function colors(t) {
  return {
    ok: t.ansi2,
    bad: t.ansi1,
    warn: t.ansi3,
    info: t.ansi4,
    off: t.dim,
    text: t.foreground,
    muted: t.muted,
    dim: t.dim,
  };
}

/** The color for a state word: up/ok/healthy, down/failed/critical, degraded/warning, else unknown. */
export function stateColor(t, state) {
  const c = colors(t);
  switch (String(state ?? "").toLowerCase()) {
    case "up": case "ok": case "healthy": case "active": case "running": case "accepted": case "connected":
      return c.ok;
    case "down": case "failed": case "critical": case "error": case "quarantined": case "unavailable":
      return c.bad;
    case "degraded": case "warning": case "blocked": case "stale": case "connecting": case "loading":
      return c.warn;
    default:
      return c.off;
  }
}

/** A round status dot. */
export function dot(color, size = 7) {
  return div().size(size).flex_none().rounded_full().bg(color);
}

/** A sidebar section header, the same size and color as the shipped Spaces / Agents headers.
 *  `right`: an element (buttons) or null. */
export function header(t, title, right = null) {
  return h_flex().h(31).flex_none().pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
    .child(title)
    .when(Boolean(right), (el) => el.child(right));
}

/** A small icon-sized text button for headers (stops the press so a drag never starts). */
export function iconButton(t, id, label, onClick, tip = null) {
  return div().id(id).h(20).min_w(20).px(4).flex_none().flex().items_center().justify_center().rounded(5)
    .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .child(label);
}
