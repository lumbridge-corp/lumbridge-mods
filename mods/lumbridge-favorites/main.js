// Favorites: starred terminals, moved into one "★ Favorites" space. See the repository README.
//
// A star MOVES the running terminal (same process), it doesn't mirror it: a terminal has one
// size, and a second view of it goes wrong as soon as its home pane is laid out again.
// Everything is kept in labels on the terminal, so every client sees the same:
//   lumbridge.fav=1                 starred
//   lumbridge.home={space,tab,...}  where un-starring sends it back
//   lumbridge.pinned=1              terminal.pin: top of the agent lists on every client
// A space belongs to one machine, so only the hub's terminals can move here (the kit's hubMachine:
// lumbridge-mods.json "hub", else this computer). A star on
// another machine's terminal stays where it is, and the row says so.
//
// Commands: lumbridge-favorites.toggle:<terminal> (an explicit address, for menus and scripts),
//           .toggle (the focused terminal: for a key only), .open.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, terminals, spaces, panes, focused, run, lbc, notify, shared, setShared, nextCommand } from "lumbridge";
import { hubMachine, hubName, colors, dot, header, iconButton } from "./_kit/kit.js";

// Fixed ids: adopting a terminal into an unknown id makes that space without changing the view.
const SPACE = "spkfavorites";
const TAB = "tbkfavorites";
const NAME = "★ Favorites";
const LOCK = "lumbridge.favorites.lock";

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const qualify = (id, machine) => (machine ? `${machine}/${id}` : id);
const paneOf = (addr) => panes().find((p) => p.terminal === addr);

function parseHome(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** The tab a shown space lists, by its full id. */
function findTab(spaceId, tabId) {
  const s = spaces().find((x) => x.id === spaceId);
  return { space: s ?? null, tab: s?.tabs?.find((t) => t.id === tabId) ?? null };
}

async function setLabels(addr, labels) {
  const r = await lbc(["label", addr, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`), "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `lbc label: exit ${r.code}`).trim());
}

/** Waits (with this call's own cx) until `test()` holds. False when it never did. */
async function until(cx, test, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((ok) => cx.timer.after(120, ok));
  }
  return test();
}

/**
 * Moves a live terminal to a tab: its pane goes (terminal.park also clears the place labels and
 * core keep), then the labels name the new place and the app adopts it there (keep comes back).
 * Same process throughout, and what's on screen doesn't change unless this was the pane shown.
 */
async function moveTerminal(cx, addr, spaceId, tabId, extra = {}) {
  run("terminal.park", { terminal: addr });
  if (!(await until(cx, () => !paneOf(addr)))) throw new Error(`${addr}: its pane didn't go`);
  await setLabels(addr, { "lumbridge.space": spaceId, "lumbridge.tab": tabId, ...extra });
  if (!(await until(cx, () => !!paneOf(addr)))) throw new Error(`${addr}: running, but no pane came back (lbc get ${addr})`);
}

export default class Favorites extends View {
  init(_props, cx) {
    this.busy = null;
    this.hub = undefined;
    cx.spawn(async (cx) => {
      this.hub = await hubMachine().catch(() => undefined);
      this.hubName = await hubName().catch(() => "the hub");
      cx.notify();
      for (;;) {
        const c = await nextCommand();
        // More than one shown copy hears each command: one acts.
        const lock = shared(LOCK);
        if (lock?.c === c && Date.now() - lock.at < 1500) continue;
        setShared(LOCK, { c, at: Date.now() });
        if (c === "open") this.open();
        else if (c === "toggle") {
          const addr = focused()?.terminal;
          if (addr) cx.spawn((cx) => this.toggle(cx, addr));
          else notify({ title: "Favorites", body: "No terminal is focused.", level: "warning" });
        } else if (c.startsWith("toggle:")) {
          const addr = c.slice("toggle:".length);
          cx.spawn((cx) => this.toggle(cx, addr));
        }
      }
    });
  }

  open() {
    const { space, tab } = this.place(this.hub ?? null);
    if (!space) return notify({ title: "Favorites", body: `Nothing is starred on ${this.hubName ?? "the hub"} yet.`, level: "info" });
    run("space.select", { id: space.id });
    if (tab) run("tab.select", { id: tab.id });
  }

  place(machine) {
    return findTab(qualify(SPACE, machine), qualify(TAB, machine));
  }

  async toggle(cx, addr) {
    if (this.busy) return notify({ title: "Favorites", body: `Still moving ${this.busy}. Try again in a moment.`, level: "warning" });
    const term = terminals().find((t) => t.address === addr);
    if (!term) return notify({ title: "Favorites", body: `No live terminal ${addr}.`, level: "error" });
    this.busy = addr;
    cx.notify();
    try {
      if (term.labels?.["lumbridge.fav"]) await this.unstar(cx, addr, term);
      else await this.star(cx, addr, term);
    } catch (e) {
      notify({ title: "Favorites", body: String(e.message ?? e), level: "error", timeout: 0 });
    }
    this.busy = null;
    cx.notify();
  }

  async star(cx, addr, term) {
    const machine = machineOf(addr);
    const hub = this.hub === undefined ? await hubMachine() : this.hub;
    const stay = machine !== hub;
    const localSpace = term.labels?.["lumbridge.space"];
    const localTab = term.labels?.["lumbridge.tab"];
    if (!stay && !localSpace) {
      return notify({ title: "Favorites", body: `${addr} has no pane to move (a sub-agent?): give it a pane first.`, level: "warning" });
    }
    if (stay || localTab === TAB) {
      await setLabels(addr, { "lumbridge.fav": "1" });
      run("terminal.pin", { terminal: addr, pinned: true });
      if (stay) notify({ title: "Starred, not moved", body: `${addr} runs on ${machine}. The Favorites space is on ${this.hubName ?? "the hub"}, and a space holds one machine's terminals.`, level: "warning" });
      return;
    }
    const { space, tab } = findTab(qualify(localSpace, machine), qualify(localTab, machine));
    const panesHere = tab?.panes ?? panes().filter((p) => p.tab === qualify(localTab, machine)).length;
    // Its space's only pane leaving would close the space: leave a shell so the space stays.
    if (space && space.tabs?.length === 1 && panesHere === 1) {
      const held = await lbc([
        "run", "--bg", "--keep", ...(machine ? ["--on", machine] : []),
        "--label", `lumbridge.space=${localSpace}`, "--label", `lumbridge.tab=tbkfavhold${Date.now().toString(36)}`,
        ...(space.folder ? ["--cwd", space.folder] : []), "--", "bash",
      ]);
      if (held.code !== 0) throw new Error(`Couldn't hold the space ${space.name} open: ${(held.stderr || held.stdout).trim()}`);
    }
    const home = {
      space: localSpace, tab: localTab,
      spaceName: space?.named ? space.name : null, tabName: tab?.named ? tab.name : null,
      spaceIndex: space?.index ?? null, tabIndex: tab?.index ?? null,
      label: `${space?.name ?? "?"} · ${tab?.name ?? "?"}`,
    };
    const fresh = !this.place(machine).space;
    await moveTerminal(cx, addr, SPACE, TAB, { "lumbridge.fav": "1", "lumbridge.home": JSON.stringify(home) });
    run("terminal.pin", { terminal: addr, pinned: true });
    if (fresh) {
      run("space.rename", { id: qualify(SPACE, machine), name: NAME });
      run("tab.rename", { id: qualify(TAB, machine), name: "★" });
      run("space.move", { id: qualify(SPACE, machine), index: 1 });
    }
  }

  async unstar(cx, addr, term) {
    const machine = machineOf(addr);
    run("terminal.pin", { terminal: addr, pinned: false });
    const home = parseHome(term.labels?.["lumbridge.home"]);
    const clear = { "lumbridge.fav": "", "lumbridge.home": "" };
    if (!home || term.labels?.["lumbridge.tab"] !== TAB) {
      await setLabels(addr, clear);
      if (!home && term.labels?.["lumbridge.tab"] === TAB) {
        notify({ title: "Favorites", body: `${addr} started here, so it has no home tab: it stays in ${NAME}.`, level: "info" });
      }
      return;
    }
    const spaceId = qualify(home.space, machine);
    const tabId = qualify(home.tab, machine);
    const before = findTab(spaceId, tabId);
    await moveTerminal(cx, addr, home.space, home.tab, clear);
    // A tab or space that closed when this pane left is made again under its id: name it again.
    if (!before.space) {
      if (home.spaceName) run("space.rename", { id: spaceId, name: home.spaceName });
      if (home.spaceIndex) run("space.move", { id: spaceId, index: home.spaceIndex });
    }
    if (!before.tab) {
      if (home.tabName) run("tab.rename", { id: tabId, name: home.tabName });
      if (home.tabIndex) run("tab.move", { id: tabId, index: home.tabIndex });
    }
  }

  render(cx) {
    const t = theme();
    const c = colors(t);
    const hub = this.hub;
    const stars = terminals().filter((x) => x.labels?.["lumbridge.fav"] && x.state !== "finished");
    const head = div().id("fav-head").cursor_pointer().on_click(() => this.open())
      .child(header(t, `★ Favorites${stars.length ? `  ${stars.length}` : ""}`, this.busy ? div().text_size(11).child(`moving ${this.busy}…`) : null));
    const rows = stars.map((x) => {
      const addr = x.address;
      const machine = machineOf(addr);
      const away = hub !== undefined && machine !== hub;
      const home = parseHome(x.labels?.["lumbridge.home"]);
      const state = typeof x.status === "string" ? x.status : x.status?.state;
      const sub = away ? `on ${machine}: stays there` : (home?.label ?? "here");
      return h_flex().id(`fav-${addr}`).pl(16).pr(8).py(3).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => run("pane.focus", { terminal: addr }))
        .child(dot(t[state] ?? t.idle))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).text_color(t.foreground).child(x.name || x.title || x.program?.name || addr))
          .child(div().truncate().text_size(11).text_color(away ? c.warn : t.dim).child(sub)))
        .child(iconButton(t, `fav-x-${addr}`, "★", () => run("lumbridge-favorites.toggle:" + addr), away ? "Remove the star" : "Send it back and remove the star"));
    });
    return v_flex().size_full().min_h(0).bg(t.chrome).child(head)
      .child(stars.length ? v_flex().id("fav-rows").flex_1().min_h(0).overflow_y_scroll().children(rows)
        : div().px(16).text_size(11).text_color(t.dim).child("Star a terminal to keep it here."));
  }
}
