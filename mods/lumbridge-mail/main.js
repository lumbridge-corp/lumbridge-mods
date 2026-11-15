// Mail: Lumbridge Mail in a pane, through `lbmail --json --agent` (lumbridge-maild's CLI).
//
// Filter row (accounts with unread counts, AI categories, unread only, search), the thread list
// (sender, subject, the AI's one line, category, time, unread / star, the account's colour;
// sensitive mail shows only its fixed line), a reader (plain text from `lbmail show`, quoted text
// folded), an AI strip (the thread's triage, "Ask your mail") and actions: archive, star, mark
// read, trash, "Draft reply with AI" (saved as a draft, never sent) and "Open in Lumbridge Mail"
// (the full app window, where mail is written and sent). lbmail from a mod is an agent caller: it
// cannot send, and sensitive mail reaches it only as one line.
//
// Live: it waits on `lbmail tail --count 1 --timeout 240` (one daemon event, or 4 minutes) and
// refreshes then, at most every 15 s; with no daemon it looks again every 30 s.
//
// Props: { machine?: null | "<lumbridge machine>" (where lbmail runs; default this computer),
//          account?: "<id>" (start filtered), compact?: true (a narrow data-panel column),
//          paper?: false (theme cards instead of the light paper cards) }.
//          lbmail?: ["node", "/path/fake-lbmail.mjs"] (tests; else the shared key below).
// Shared: "lumbridge.mail.lbmail": lbmail as an argv prefix (["node", "/path/fake-lbmail.mjs"] in tests);
//         "lumbridge.mail.app": the full app's argv (default ["lumbridge-mail"]).
// Commands (also for the shell: lumbridge-app do "lumbridge-mail.<cmd>"): refresh, next, prev,
//   open, open:<account/thread>, back, archive, star, read, trash, trash!, draft, draft:<instruction>,
//   ask:<question>, search:<query>, search: (clears), account:<id|all>, category:<c|all>, unread,
//   app, start, focus.
// Keys while the pane has the keyboard: j/k (or ↓/↑) move, Enter opens, Esc back, e archive,
//   s star, u read/unread, # trash (twice), / search, a ask, r draft reply, o open in Lumbridge Mail,
//   g refresh. More in README.md beside this file.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, ScrollHandle } from "gpui-base";
import { theme, props, exec, run, notify, shared, nextCommand, openOverlay } from "lumbridge";
import { colors, dot, iconButton } from "./_kit/kit.js";
import {
  CATEGORIES, CATEGORY_LABEL, DEFAULT_DRAFT, parseRun, startFailure, failureText, ref, listArgs, actArgs, draftArgs,
  askArgs, tailCommand, tailStop, tailEvent, args, accountList, categoryCounts, threadRow, threadList, shortTime, longTime,
  messageList, plainToMarkdown, daemonState, paneFailure, headline, nextRefreshDelay, MIN_REFRESH_MS, IDLE_POLL_MS, DOWN_POLL_MS,
} from "./logic.js";

const INSTALL_URL = "https://github.com/lumbridge-corp/lumbridge-mail#readme";

const MOD = "lumbridge-mail";
const LBMAIL_KEY = "lumbridge.mail.lbmail";
const APP_KEY = "lumbridge.mail.app";
const TAIL_S = 240;
// The paper look: light cards on the dark chrome.
// The paper look: light cards on the dark chrome (the kit's paper()).
const PAPER = {
  card: "#fbfbf8", edge: "#e4e2db", line: "#e1e0d9", text: "#0b0b0b", muted: "#52514e", dim: "#86847d",
  hover: "#f0efe9", selected: "#e3ecfa", accent: "#2a78d6", warn: "#d98e00", bad: "#d03b3b", ok: "#0ca30c", chip: "#ecebe5",
};

function look(t, paper) {
  const c = colors(t);
  const chrome = { chrome: t.chrome, ctext: t.foreground, cmuted: t.muted, cdim: t.dim, cline: t.border, chover: t.hover, cinput: t.input, cbg: t.background, caccent: t.accent };
  if (paper) return { ...chrome, ...PAPER };
  return {
    ...chrome, card: t.surface, edge: t.border, line: t.border, text: t.foreground, muted: t.muted, dim: t.dim,
    hover: t.hover, selected: t.selected, accent: t.accent, warn: c.warn, bad: c.bad, ok: c.ok, chip: t.raised,
  };
}

const sleep = (cx, ms) => new Promise((ok) => cx.timer.after(ms, ok));

export default class Mail extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.machine = p.machine ?? null;
    this.lbmailArgv = Array.isArray(p.lbmail) && p.lbmail.length ? p.lbmail : null; // tests: a fake lbmail
    this.compact = Boolean(p.compact);
    this.paper = p.paper !== false;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.width = 900;

    // Filter
    this.account = p.account ?? null; // null = the unified inbox (anon accounts only when picked)
    this.category = "all";
    this.unread = false;
    this.query = "";

    // Data (last good kept on a blip)
    this.accounts = [];
    this.counts = categoryCounts([]);
    this.rows = [];
    this.failure = null; // a whole-pane failure (missing, daemon, machine)
    this.listError = null;
    this.at = 0; // ms of the last good refresh
    this.busy = false;
    this.loaded = false; // one refresh has finished (with mail, no accounts, or a failure)
    this.daemon = daemonState(null);
    this.live = false; // tail is answering
    this.lastRefresh = 0;
    this.closed = false;
    // Names this copy's waiting tail, so close() can end exactly that one.
    this.token = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`;

    // Selection and reader
    this.sel = null; // account/thread
    this.reading = null; // { key, messages, error, loading }
    this.showQuoted = {}; // "<key>#<message>#<part>" -> true
    this.compactReader = false; // narrow: the reader replaces the list
    this.confirmTrash = null; // key armed by the first #
    this.confirmStart = false;
    this.note = null; // { text, level } under the actions

    // AI
    this.askState = InputState.new({ placeholder: "Ask your mail…" });
    this.askState.on("submit", (_e, cx) => this.ask(this.askState.value(), cx));
    this.answer = null; // { question, text, sources, error, loading }
    this.draftState = InputState.new({ placeholder: DEFAULT_DRAFT });
    this.draftState.on("submit", (_e, cx) => this.draft(this.draftState.value(), cx));
    this.drafting = null; // key while the instruction box is open
    this.draftResult = null; // { key, loading, draft, error }

    this.searchState = InputState.new({ placeholder: "Search  (from: subject: is:unread has:attachment …)" });
    this.searchState.on("submit", (_e, cx) => { this.query = this.searchState.value().trim(); this.handle.focus(); this.refresh(cx); });
    this.typing = 0;
    for (const s of [this.askState, this.draftState, this.searchState]) {
      s.on("focus", (_e, cx) => { this.typing += 1; cx.notify(); });
      s.on("blur", (_e, cx) => { this.typing = Math.max(0, this.typing - 1); cx.notify(); });
    }

    this.refresh(cx);
    this.follow(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------ lbmail

  lbmailPrefix() {
    const prefix = this.lbmailArgv ?? shared(LBMAIL_KEY);
    return Array.isArray(prefix) && prefix.length ? prefix.map(String) : [typeof prefix === "string" && prefix ? prefix : "lbmail"];
  }

  async lbmail(a, timeout = 30000) {
    const argv = this.lbmailPrefix();
    try {
      return parseRun(await exec(argv[0], [...argv.slice(1), ...a], { on: this.machine, timeout }));
    } catch (e) {
      return startFailure(e);
    }
  }

  // One wait for a daemon event, run so that close() can end it (logic.js tailCommand).
  async tail() {
    const c = tailCommand(this.token, this.lbmailPrefix(), TAIL_S);
    try {
      return parseRun(await exec(c.cmd, c.args, { on: this.machine, timeout: (TAIL_S + 20) * 1000 }));
    } catch (e) {
      return startFailure(e);
    }
  }

  // The pane, tab or dialog went: stop following and end the waiting tail (it would otherwise wait
  // out its 4 minutes). Started here and awaited directly, as the app's close() asks.
  async close() {
    this.closed = true;
    const c = tailStop(this.token);
    try { await exec(c.cmd, c.args, { on: this.machine, timeout: 5000 }); } catch {}
  }

  filter() {
    return { account: this.account, category: this.category, unread: this.unread, query: this.query, limit: 60 };
  }

  refresh(cx) {
    if (this.closed) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.lastRefresh = Date.now();
    cx.spawn(async (cx) => {
      // Whatever lbmail answers (or throws), busy is cleared and the pane shows what happened.
      try {
        await this.load(cx);
      } catch (e) {
        this.failure = paneFailure(e);
      } finally {
        this.busy = false;
        this.loaded = true;
      }
      if (this.again) { this.again = false; this.refresh(cx); }
      cx.notify();
    });
  }

  async load(cx) {
    // A failed status or accounts call is the whole pane's failure when lbmail or the daemon is not
    // there, or when nothing was read yet; after a good read it is a blip: the last mail stays, marked stale.
    const whole = (r) => ["missing", "daemon", "machine", "timeout"].includes(r.kind) || !this.at;
    const status = await this.lbmail(args("status"));
    if (!status.ok) { if (whole(status)) this.failure = status; else this.listError = status; return; }
    const acc = await this.lbmail(args("accounts"));
    if (!acc.ok) { if (whole(acc)) this.failure = acc; else this.listError = acc; return; }
    this.failure = null;
    this.daemon = daemonState(status.data);
    const accounts = Array.isArray(acc.data) ? acc.data : [];
    // Unread per account (one counts each; they read the daemon's store, not the mail servers).
    const unreadBy = {};
    for (const a of accounts) {
      const r = await this.lbmail(args("counts", "--account", a.id));
      if (r.ok) unreadBy[a.id] = categoryCounts(r.data).unread;
    }
    this.accounts = accountList(accounts, status.data, unreadBy);
    if (this.account && !this.accounts.some((a) => a.id === this.account)) this.account = null;
    const cnt = await this.lbmail(args("counts", this.account ? ["--account", this.account] : null));
    if (cnt.ok) this.counts = categoryCounts(cnt.data);
    if (this.accounts.length) {
      const list = await this.lbmail(listArgs(this.filter()));
      if (list.ok) {
        const byId = Object.fromEntries(this.accounts.map((a) => [a.id, a]));
        this.rows = threadList(list.data).map((t) => threadRow(t, byId));
        this.listError = null;
        this.at = Date.now();
      } else this.listError = list;
    } else this.rows = [];
    if (this.sel && !this.rows.some((r) => r.key === this.sel) && !this.reading) this.sel = null;
    if (!this.sel && this.rows.length && !this.compact) this.select(this.rows[0].key, cx, false);
  }

  // Follows the daemon: one event (or 4 minutes) per tail, then a refresh no sooner than 15 s
  // after the last. No daemon: look again every 30 s. Ends with the copy (its next cx use).
  follow(cx) {
    cx.spawn(async (cx) => {
      while (!this.closed) {
        if (this.failure) {
          this.live = false;
          await sleep(cx, this.failure.kind === "missing" ? IDLE_POLL_MS : DOWN_POLL_MS);
          this.refresh(cx);
          continue;
        }
        const started = Date.now();
        const r = await this.tail();
        if (this.closed) return;
        if (!r.ok) {
          this.live = false;
          if (r.kind === "daemon" || r.kind === "missing") this.refresh(cx);
          await sleep(cx, MIN_REFRESH_MS);
          continue;
        }
        const event = tailEvent(r.data) !== null;
        this.live = true;
        const wait = nextRefreshDelay(this.lastRefresh);
        if (wait) await sleep(cx, wait);
        if (event || Date.now() - this.lastRefresh >= IDLE_POLL_MS) this.refresh(cx);
        // A tail that returns at once and keeps doing so (a flood of events) still waits 15 s per round.
        if (Date.now() - started < MIN_REFRESH_MS) await sleep(cx, MIN_REFRESH_MS);
        cx.notify();
      }
    });
  }

  // ------------------------------------------------------------ selection and reader

  row(key = this.sel) {
    return this.rows.find((r) => r.key === key) ?? null;
  }

  select(key, cx, open = true) {
    if (!key) return;
    if (this.sel !== key) { this.confirmTrash = null; this.drafting = null; this.note = null; }
    this.sel = key;
    const i = this.rows.findIndex((r) => r.key === key);
    if (i >= 0) this.scroll.scroll_to_item(i);
    if (this.compact || this.width < 760) { if (open) this.compactReader = true; else return; }
    if (this.reading?.key === key && !this.reading.error) return;
    this.reading = { key, messages: [], loading: true, error: null };
    cx.spawn(async (cx) => {
      const r = await this.lbmail(args("show", key));
      if (this.reading?.key !== key) return; // moved on meanwhile
      try {
        this.reading = r.ok ? { key, messages: messageList(r.data), loading: false, error: null } : { key, messages: [], loading: false, error: r };
      } catch (e) {
        this.reading = { key, messages: [], loading: false, error: paneFailure(e) };
      }
      cx.notify();
    });
  }

  move(d, cx) {
    if (!this.rows.length) return;
    const i = this.rows.findIndex((r) => r.key === this.sel);
    const n = i < 0 ? 0 : Math.max(0, Math.min(this.rows.length - 1, i + d));
    this.select(this.rows[n].key, cx, false);
  }

  // ------------------------------------------------------------ actions

  act(action, cx) {
    const r = this.row();
    if (!r) return;
    if (r.readonly) { this.note = { text: "This account is read-only: nothing is changed on the server.", level: "warn" }; return; }
    if (action === "trash" && this.confirmTrash !== r.key) {
      this.confirmTrash = r.key;
      this.note = { text: "Move this thread to the trash? Press # again or click Trash again.", level: "warn" };
      return;
    }
    this.confirmTrash = null;
    const t = r.raw;
    const word = { archive: "Archived", trash: "Moved to the trash", star: t.flagged ? "Unstarred" : "Starred", read: t.unread_count > 0 ? "Marked read" : "Marked unread" }[action];
    cx.spawn(async (cx) => {
      const res = await this.lbmail(actArgs(action, t));
      if (res.ok) {
        this.note = { text: `${word}. Queued; the daemon sends it to the server.`, level: "ok" };
        if (action === "archive" || action === "trash") {
          const i = this.rows.findIndex((x) => x.key === r.key);
          this.rows = this.rows.filter((x) => x.key !== r.key);
          const next = this.rows[Math.min(i, this.rows.length - 1)];
          this.reading = null;
          this.compactReader = false;
          this.sel = null;
          if (next) this.select(next.key, cx, false);
        } else if (action === "star") t.flagged = !t.flagged;
        else if (action === "read") t.unread_count = t.unread_count > 0 ? 0 : 1;
        Object.assign(r, threadRow(t, Object.fromEntries(this.accounts.map((a) => [a.id, a]))));
        this.refresh(cx);
      } else this.note = { text: failureText(res), level: res.kind === "refused" ? "warn" : "bad" };
      cx.notify();
    });
  }

  startDraft() {
    const r = this.row();
    if (!r) return;
    if (r.sensitive) { this.note = { text: "Sensitive mail is never given to a model: write this reply yourself in Lumbridge Mail.", level: "warn" }; return; }
    this.drafting = r.key;
    this.draftResult = null;
    this.draftState.focus();
  }

  draft(instruction, cx) {
    const r = this.row();
    if (!r) return;
    this.drafting = null;
    this.draftResult = { key: r.key, loading: true, draft: null, error: null };
    this.handle.focus();
    cx.spawn(async (cx) => {
      const res = await this.lbmail(draftArgs(r.raw, instruction), 180000);
      this.draftResult = res.ok ? { key: r.key, loading: false, draft: res.data, error: null } : { key: r.key, loading: false, draft: null, error: res };
      if (res.ok) notify({ title: "Mail: draft saved", body: `In ${this.label(r.account)}'s drafts. Nothing was sent: open Lumbridge Mail to review and send.`, level: "success" });
      cx.notify();
    });
  }

  ask(question, cx) {
    const q = String(question ?? "").trim();
    if (!q) return;
    this.answer = { question: q, loading: true, text: "", sources: [], error: null };
    cx.spawn(async (cx) => {
      const res = await this.lbmail(askArgs(q, this.account), 180000);
      this.answer = res.ok ? { question: q, loading: false, text: res.data?.text ?? "", sources: res.data?.sources ?? [], error: null } : { question: q, loading: false, text: "", sources: [], error: res };
      cx.notify();
    });
  }

  // The full app window (for writing and sending), detached so the pane doesn't wait for it.
  openApp() {
    if (this.machine) { this.note = { text: `Lumbridge Mail opens on the computer it runs on; this pane reads ${this.machine}.`, level: "warn" }; return; }
    const app = shared(APP_KEY);
    const argv = (Array.isArray(app) && app.length ? app : ["lumbridge-mail"]).map(String);
    const line = argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    exec("sh", ["-c", `command -v ${argv[0].includes("/") ? `'${argv[0]}'` : argv[0]} >/dev/null 2>&1 || exit 127; (setsid ${line} </dev/null >/dev/null 2>&1 &)`], { timeout: 10000 })
      .then((r) => { if (r.code === 127) notify({ title: "Lumbridge Mail isn't installed here", body: `See ${INSTALL_URL} to install it, or use lbmail in a terminal.`, level: "warning" }); })
      .catch((e) => notify({ title: "Couldn't open Lumbridge Mail", body: String(e?.message ?? e), level: "error" }));
  }

  // Starts lumbridge-maild here: its systemd user unit if installed, else the program, detached.
  start(cx) {
    if (!this.confirmStart) { this.confirmStart = true; return; }
    this.confirmStart = false;
    cx.spawn(async (cx) => {
      try {
        await exec("sh", ["-c", "if systemctl --user cat lumbridge-maild >/dev/null 2>&1; then systemctl --user start lumbridge-maild; else command -v lumbridge-maild >/dev/null || exit 127; (setsid lumbridge-maild </dev/null >/dev/null 2>&1 &); fi"], { on: this.machine, timeout: 20000 });
      } catch (e) {
        notify({ title: "Couldn't start lumbridge-maild", body: String(e?.message ?? e), level: "error" });
      }
      await sleep(cx, 1500);
      this.refresh(cx);
    });
  }

  // A terminal running lbmail (the fallback where this pane can't run, or for account setup).
  terminal(cmdline, name = "Mail") {
    const argv = ["bash", "-lc", `${cmdline}; echo; echo 'lbmail --help for every command.'; exec bash -l`];
    if (this.machine) run("space.new", { machine: this.machine, name, argv });
    else run("tab.new", { name, argv });
  }

  label(id) {
    return this.accounts.find((a) => a.id === id)?.label ?? id;
  }

  setAccount(id, cx) {
    this.account = id === "all" || !id ? null : id;
    this.sel = null;
    this.reading = null;
    this.refresh(cx);
  }

  command(c, cx) {
    const arg = c.includes(":") ? c.slice(c.indexOf(":") + 1) : null;
    const name = c.includes(":") ? c.slice(0, c.indexOf(":")) : c;
    switch (name) {
      case "focus": this.handle.focus(); break;
      case "refresh": this.refresh(cx); break;
      case "next": this.move(1, cx); break;
      case "prev": this.move(-1, cx); break;
      case "open": this.select(arg || this.sel, cx, true); break;
      case "back": this.compactReader = false; break;
      case "archive": case "star": case "read": this.act(name, cx); break;
      case "trash": this.act("trash", cx); break;
      case "trash!": this.confirmTrash = this.sel; this.act("trash", cx); break;
      case "draft": if (arg) this.draft(arg, cx); else this.startDraft(); break;
      case "ask": this.ask(arg, cx); break;
      case "search": this.query = (arg ?? "").trim(); this.searchState.set_value(this.query); this.refresh(cx); break;
      case "account": this.setAccount(arg, cx); break;
      case "category": this.category = arg && CATEGORIES.includes(arg) ? arg : "all"; this.refresh(cx); break;
      case "unread": this.unread = !this.unread; this.refresh(cx); break;
      case "app": this.openApp(); break;
      case "start": this.confirmStart = true; this.start(cx); break;
    }
  }

  onKey(e, cx) {
    // Letters act only while the pane itself has the keyboard: a key typed in a box (search, ask,
    // draft) is the box's. is_focused() is false while a child Input holds the focus, so this holds
    // even before the box's "focus" event arrives (`typing` alone let the first letter through).
    if (this.typing || !this.handle.is_focused()) {
      if (e.key === "escape") { this.drafting = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    const k = e.key_char ?? e.key;
    const m = e.modifiers ?? {};
    if (m.control || m.platform || m.alt) return;
    let done = true;
    if (k === "j" || e.key === "down") this.move(1, cx);
    else if (k === "k" || e.key === "up") this.move(-1, cx);
    else if (e.key === "enter") this.select(this.sel ?? this.rows[0]?.key, cx, true);
    else if (e.key === "escape") { if (this.compactReader) this.compactReader = false; else if (this.query) { this.query = ""; this.searchState.set_value(""); this.refresh(cx); } else { this.confirmTrash = null; this.note = null; } }
    else if (k === "e") this.act("archive", cx);
    else if (k === "s") this.act("star", cx);
    else if (k === "u") this.act("read", cx);
    else if (k === "#") this.act("trash", cx);
    else if (k === "/") this.searchState.focus();
    else if (k === "a") this.askState.focus();
    else if (k === "r") this.startDraft();
    else if (k === "o") this.openApp();
    else if (k === "g") this.refresh(cx);
    else done = false;
    if (done) { cx.stop_propagation(); cx.notify(); }
  }

  // ------------------------------------------------------------ render

  render(_cx) {
    const t = theme();
    const L = look(t, this.paper);
    const narrow = this.compact || this.width < 760;
    let body;
    if (this.failure) body = this.renderFailure(L);
    else if (!this.loaded) body = this.message(L, "Reading your mail…");
    else if (!this.accounts.length) body = this.renderNoAccounts(L);
    else if (narrow) body = v_flex().flex_1().min_h(0).px(10).pb(10).child(this.compactReader && this.sel ? this.renderReader(L, true) : this.renderList(L));
    else {
      const listW = Math.max(320, Math.min(520, Math.round(this.width * 0.42)));
      body = h_flex().flex_1().min_h(0).gap(10).px(10).pb(10).items_stretch()
        .child(v_flex().w(listW).flex_none().min_h(0).child(this.renderList(L)))
        .child(v_flex().flex_1().min_w(0).min_h(0).child(this.renderReader(L, false)));
    }
    return v_flex().id("root").track_focus(this.handle).size_full().min_h(0).bg(L.chrome).text_size(13).text_color(L.ctext)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 2) { this.width = size.width; cx.notify(); } })
      .on_key_down((e, cx) => this.onKey(e, cx))
      // A press anywhere but a box gives the pane the keyboard (the boxes stop their own presses).
      .on_mouse_down("left", () => { if (!this.typing) this.handle.focus(); })
      .child(this.renderTop(L, t))
      .when(!this.failure && this.accounts.length > 0, (el) => el.child(this.renderFilters(L)))
      .child(body)
      .when(!this.failure && this.accounts.length > 0, (el) => el.child(this.renderAsk(L)));
  }

  renderTop(L, t) {
    const h = headline({ failure: this.failure, accounts: this.accounts, live: this.live, at: this.at, loaded: this.loaded, paused: this.daemon.paused });
    const c = colors(t);
    const color = { ok: c.ok, warn: c.warn, error: c.bad, stopped: c.bad, empty: c.dim }[h.word] ?? c.dim;
    return h_flex().h(36).flex_none().pl(14).pr(8).gap(8).items_center()
      .child(div().flex_none().text_size(13.5).font_semibold().child("Mail"))
      .child(dot(color, 7))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(L.cdim).child(h.text))
      .when(Boolean(this.busy), (el) => el.child(div().text_size(11).text_color(L.cdim).frames(["·  ", "·· ", "···", " ··", "  ·", "   "], 140).child("")))
      .child(iconButton(t, "m-refresh", "↻", (_e, cx) => this.refresh(cx), "Refresh (g)"))
      .child(iconButton(t, "m-term", ">_", () => this.terminal("lbmail ls"), "lbmail in a terminal"))
      .child(iconButton(t, "m-app", "↗", () => this.openApp(), "Open in Lumbridge Mail: write and send there (o)"));
  }

  chip(L, id, text, on, onClick, o = {}) {
    return h_flex().id(id).h(24).flex_none().px(8).gap(5).items_center().rounded(12).cursor_pointer()
      .border_1().border_color(on ? L.caccent : L.cline).bg(on ? L.chover : L.chrome)
      .text_size(11.5).text_color(on ? L.ctext : L.cmuted)
      .hover((s) => s.bg(L.chover).text_color(L.ctext))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .when(Boolean(o.tip), (el) => el.tooltip(o.tip))
      .when(Boolean(o.color), (el) => el.child(dot(o.color, 7)))
      .child(div().child(text))
      .when(o.count !== undefined && o.count !== null && o.count > 0, (el) => el.child(div().text_size(10.5).font_semibold().text_color(on ? L.caccent : L.ctext).child(String(o.count))))
      .when(Boolean(o.badge), (el) => el.child(div().text_size(10).text_color(o.badgeColor ?? L.cdim).child(o.badge)));
  }

  renderFilters(L) {
    const total = this.accounts.filter((a) => !a.anon).reduce((n, a) => n + (a.unread ?? 0), 0);
    const accounts = h_flex().flex_wrap().gap(6).px(12).pb(6)
      .child(this.chip(L, "mf-all", "All", this.account === null, (_e, cx) => this.setAccount("all", cx), { count: total, tip: "Every account but anon ones (those only when picked)" }))
      .children(this.accounts.map((a) => this.chip(L, `mf-a-${a.id}`, a.label, this.account === a.id, (_e, cx) => this.setAccount(a.id, cx), {
        color: a.color, count: a.unread,
        badge: a.state === "paused" ? "paused" : a.state === "offline" || a.state === "error" ? "offline" : a.readonly ? "read-only" : a.anon ? "anon" : null,
        badgeColor: a.state === "paused" || a.state === "offline" || a.state === "error" ? L.warn : L.cdim,
        tip: `${a.email} · ${a.note}${a.readonly ? " · read-only: no actions" : ""}${a.anon ? " · anon: kept out of the unified inbox" : ""}${a.queued ? ` · ${a.queued} queued` : ""}`,
      })));
    const cats = h_flex().flex_wrap().gap(6).px(12).pb(8)
      .child(this.chip(L, "mf-c-all", "All mail", this.category === "all", (_e, cx) => { this.category = "all"; this.refresh(cx); }, { count: this.counts.unread }))
      .children(CATEGORIES.filter((c) => this.counts.by[c]?.threads || this.category === c).map((c) =>
        this.chip(L, `mf-c-${c}`, CATEGORY_LABEL[c], this.category === c, (_e, cx) => { this.category = this.category === c ? "all" : c; this.refresh(cx); }, { count: this.counts.by[c]?.unread ?? 0 })))
      .child(this.chip(L, "mf-unread", "Unread only", this.unread, (_e, cx) => { this.unread = !this.unread; this.refresh(cx); }));
    const search = h_flex().id("mf-search").mx(12).mb(8).h(30).flex_none().px(10).gap(6).items_center().rounded(8)
      .border_1().border_color(this.query ? L.caccent : L.cinput).bg(L.cbg).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().text_color(L.cdim).text_size(12).child("/"))
      .child(Input.new(this.searchState).flex_1().h_full().text_size(12.5).text_color(L.ctext))
      .when(Boolean(this.query), (el) => el.child(div().id("mf-search-x").px(4).text_color(L.cdim).cursor_pointer().hover((s) => s.text_color(L.ctext))
        .on_click((_e, cx) => { this.query = ""; this.searchState.set_value(""); this.refresh(cx); }).child("×")));
    return v_flex().flex_none().child(accounts).child(cats).child(search);
  }

  card(L) {
    return v_flex().rounded(10).border_1().border_color(L.edge).bg(L.card).text_color(L.text).when(this.paper, (el) => el.shadow_sm());
  }

  message(L, text, color = null) {
    return v_flex().flex_1().min_h(0).px(10).pb(10)
      .child(this.card(L).p(16).child(div().text_color(color ?? L.muted).child(text)));
  }

  renderList(L) {
    if (!this.rows.length) {
      const what = this.query ? `Nothing matches “${this.query}”.` : this.unread ? "No unread mail here." : this.category !== "all" ? `No ${CATEGORY_LABEL[this.category].toLowerCase()} in this inbox.` : "Inbox zero: nothing here.";
      return this.card(L).flex_1().min_h(0).p(16)
        .child(div().text_color(L.muted).child(this.listError ? failureText(this.listError) : what));
    }
    return this.card(L).flex_1().min_h(0).overflow_hidden()
      .child(v_flex().id("m-list").flex_1().min_h(0).py(4).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(this.rows.map((r, i) => this.renderRow(L, r, i))))
      .when(Boolean(this.listError), (el) => el.child(div().px(12).py(4).text_size(11).text_color(L.warn).child(`stale: ${failureText(this.listError)}`)));
  }

  renderRow(L, r, i) {
    const on = r.key === this.sel;
    const id = `m-row-${i}`;
    const title = div().flex_1().min_w(0).truncate().text_size(12.8).when(r.unread, (el) => el.font_semibold()).text_color(L.text).child(r.subject);
    return h_flex().id(id).flex_none().mx(4).pl(8).pr(10).py(7).gap(8).items_start().rounded(7).cursor_pointer()
      .bg(on ? L.selected : PAPER.card + "00").hover((s) => s.bg(on ? L.selected : L.hover))
      .on_click((_e, cx) => { this.handle.focus(); this.select(r.key, cx, true); cx.notify(); })
      .child(div().w(3).h(34).flex_none().rounded(2).bg(r.color))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().w(7).flex_none().text_size(9).text_color(L.accent).child(r.unread ? "●" : ""))
          .when(!r.sensitive, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(r.unread ? L.text : L.muted).when(r.unread, (x) => x.font_semibold()).child(r.sender || " ")))
          .when(r.sensitive, (el) => el.child(title))
          .when(r.starred, (el) => el.child(div().flex_none().text_color(L.warn).child("★")))
          .when(r.attachments && !r.sensitive, (el) => el.child(div().flex_none().text_size(11).text_color(L.dim).child("⎙")))
          .child(div().flex_none().text_size(11).text_color(L.dim).child(shortTime(r.date))))
        .when(!r.sensitive, (el) => el.child(h_flex().pl(13).gap(6).items_center().child(title)
          .when(Boolean(r.category) && r.category !== "other", (x) => x.child(div().flex_none().px(6).h(17).flex().items_center().rounded(4).bg(L.chip).text_size(10).text_color(L.muted).child(CATEGORY_LABEL[r.category] ?? r.category)))))
        .when(!r.sensitive && Boolean(r.summary || r.snippet), (el) => el.child(div().pl(13).truncate().text_size(11.5).text_color(r.suspicious ? L.warn : L.dim)
          .child(`${r.suspicious ? "⚠ suspicious · " : ""}${r.needsReply ? "needs a reply · " : ""}${r.summary || r.snippet}`))));
  }

  button(L, id, text, onClick, o = {}) {
    const off = Boolean(o.disabled);
    return h_flex().id(id).h(28).flex_none().px(10).gap(6).items_center().rounded(7).border_1()
      .border_color(o.primary ? L.accent : L.edge).bg(o.primary ? L.accent : L.card).text_size(12)
      .text_color(o.primary ? "#ffffff" : o.danger ? L.bad : L.text)
      .when(off, (el) => el.opacity(0.45))
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(onClick))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(Boolean(o.tip), (el) => el.tooltip(o.tip))
      .child(text)
      .when(Boolean(o.key), (el) => el.child(div().text_size(10.5).text_color(o.primary ? "#ffffffaa" : L.dim).child(o.key)));
  }

  renderReader(L, withBack) {
    const r = this.row();
    if (!r) return this.card(L).flex_1().min_h(0).p(16).child(div().text_color(L.muted).child("Pick a thread (j/k, Enter)."));
    const rd = this.reading?.key === r.key ? this.reading : null;
    const ro = r.readonly;
    const acct = this.accounts.find((a) => a.id === r.account);
    const tip = ro ? "Read-only account: nothing is changed on the server" : null;
    const actions = h_flex().flex_wrap().gap(6).px(16).py(10).border_b(1).border_color(L.line)
      .when(withBack, (el) => el.child(this.button(L, "ma-back", "← Back", (_e, cx) => { this.compactReader = false; cx.notify(); }, { key: "Esc" })))
      .child(this.button(L, "ma-archive", "Archive", (_e, cx) => this.act("archive", cx), { key: "e", disabled: ro, tip }))
      .child(this.button(L, "ma-star", r.starred ? "Unstar" : "Star", (_e, cx) => this.act("star", cx), { key: "s", disabled: ro, tip }))
      .child(this.button(L, "ma-read", r.unread ? "Mark read" : "Mark unread", (_e, cx) => this.act("read", cx), { key: "u", disabled: ro, tip }))
      .child(this.button(L, "ma-trash", this.confirmTrash === r.key ? "Trash: sure?" : "Trash", (_e, cx) => this.act("trash", cx), { key: "#", disabled: ro, danger: true, tip }))
      .child(div().flex_1())
      .child(this.button(L, "ma-draft", "Draft reply with AI", () => this.startDraft(), { key: "r", disabled: r.sensitive, tip: r.sensitive ? "Sensitive mail never goes to a model" : "Saves a draft; never sends" }))
      .child(this.button(L, "ma-app", "Open in Lumbridge Mail", () => this.openApp(), { key: "o", primary: true, tip: "The full app: write, review and send there" }));

    const head = v_flex().px(16).pt(14).pb(8).gap(4)
      .child(h_flex().gap(8).items_center()
        .child(dot(r.color, 8))
        .child(div().text_size(11.5).text_color(L.dim).child(`${acct?.label ?? r.account}${ro ? " · read-only" : ""}${acct?.anon ? " · anon" : ""}${r.count > 1 ? ` · ${r.count} messages` : ""}`)))
      .child(div().text_size(16).font_semibold().text_color(L.text).child(r.subject));

    const strip = this.renderTriage(L, r);

    let content;
    if (!rd || rd.loading) content = div().px(16).py(10).text_color(L.dim).child("Reading…");
    else if (rd.error) content = div().px(16).py(10).text_color(L.bad).child(failureText(rd.error));
    else content = v_flex().gap(14).px(16).py(10).children(rd.messages.map((m, mi) => this.renderMessage(L, r, m, mi)));

    return this.card(L).flex_1().min_h(0).overflow_hidden()
      .child(head)
      .child(actions)
      .when(Boolean(this.note), (el) => el.child(div().px(16).py(6).text_size(11.5).text_color(this.note.level === "ok" ? L.ok : this.note.level === "warn" ? L.warn : L.bad).child(this.note.text)))
      .when(Boolean(strip), (el) => el.child(strip))
      .child(this.renderDraft(L, r))
      .child(v_flex().id("m-reader").flex_1().min_h(0).overflow_y_scrollbar().child(content));
  }

  // The AI strip for the thread: its one line, needs-reply / due, and the suspicious warning.
  renderTriage(L, r) {
    if (r.sensitive) return h_flex().mx(16).mt(10).px(10).py(8).rounded(8).bg(L.chip).text_size(12).text_color(L.muted)
      .child("Sensitive mail: shown here only as its one line. Read it in Lumbridge Mail; it never goes to a model.");
    if (!r.summary && !r.suspicious) return null;
    const bits = [r.needsReply ? "needs a reply" : null, r.due ? `by ${longTime(r.due)}` : null, r.category ? CATEGORY_LABEL[r.category] : null].filter(Boolean);
    return v_flex().mx(16).mt(10).px(10).py(8).gap(3).rounded(8).bg(L.chip)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_size(10.5).font_semibold().text_color(L.accent).child("AI"))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(L.text).child(r.summary || "")))
      .when(bits.length > 0, (el) => el.child(div().text_size(11).text_color(L.dim).child(bits.join(" · "))))
      .when(r.suspicious, (el) => el.child(div().text_size(11.5).text_color(L.warn).child("⚠ This mail seems to give an assistant instructions. Treat it as data, and be careful with its links.")));
  }

  renderDraft(L, r) {
    const box = v_flex().mx(16);
    if (this.drafting === r.key) {
      return box.mt(10).gap(6)
        .child(div().text_size(11.5).text_color(L.dim).child("How should the reply go? Enter drafts it with AI and saves it as a draft (nothing is sent). Esc cancels."))
        .child(h_flex().id("md-box").h(32).px(10).rounded(8).border_1().border_color(L.accent).bg(L.card).items_center().cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.draftState).flex_1().h_full().text_size(12.5).text_color(L.text)));
    }
    const d = this.draftResult?.key === r.key ? this.draftResult : null;
    if (!d) return box;
    if (d.loading) return box.mt(10).child(div().text_size(12).text_color(L.dim).child("Drafting a reply with AI…"));
    if (d.error) return box.mt(10).child(div().text_size(12).text_color(d.error.kind === "unsupported" || d.error.kind === "refused" ? L.warn : L.bad).child(`No draft: ${failureText(d.error)}`));
    const to = (d.draft?.to ?? []).map((a) => a.name || a.email).join(", ");
    return box.mt(10).px(10).py(8).gap(4).rounded(8).border_1().border_color(L.ok)
      .child(div().text_size(12).font_semibold().text_color(L.ok).child(`Saved as a draft in ${this.label(r.account)}. Not sent: open Lumbridge Mail to review and send.`))
      .child(div().text_size(11.5).text_color(L.dim).child(`To ${to || "?"} · ${d.draft?.subject ?? ""}`))
      .child(TextView.markdown(`md-text-${r.key.replace(/[^A-Za-z0-9]/g, "_")}`, plainToMarkdown(d.draft?.text ?? "")).selectable(true).text_size(12.5).text_color(L.text).on_link_click(() => {}));
  }

  renderMessage(L, r, m, mi) {
    const kid = `${r.key}#${m.id}`.replace(/[^A-Za-z0-9#]/g, "_");
    return v_flex().gap(6)
      .when(mi > 0, (el) => el.pt(12).border_t(1).border_color(L.line))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(L.text).child(m.sensitive ? m.subject : m.from))
        .child(div().flex_none().text_size(11).text_color(L.dim).child(longTime(m.date))))
      .when(m.attachments.length > 0, (el) => el.child(div().text_size(11.5).text_color(L.dim).child(`⎙ ${m.attachments.join(" · ")}`)))
      .when(m.suspicious || m.replyToDiffers, (el) => el.child(div().text_size(11.5).text_color(L.warn)
        .child(`⚠ ${[m.suspicious ? `Suspicious${m.why.length ? `: ${m.why.join("; ")}` : ""}` : null, m.replyToDiffers ? "replies go to a different address" : null].filter(Boolean).join(" · ")}`)))
      .children(m.parts.map((part, pi) => {
        const key = `${kid}#${pi}`;
        if (!part.quoted || this.showQuoted[key]) {
          return v_flex().when(part.quoted, (el) => el.pl(10).border_l(2).border_color(L.line))
            .child(TextView.markdown(`mm-${key}`, plainToMarkdown(part.text)).selectable(true).text_size(13).text_color(part.quoted ? L.muted : L.text).on_link_click(() => {}))
            .when(part.quoted, (el) => el.child(div().id(`mq-hide-${key}`).pt(2).text_size(11).text_color(L.accent).cursor_pointer().on_click((_e, cx) => { delete this.showQuoted[key]; cx.notify(); }).child("Hide quoted text")));
        }
        return div().id(`mq-${key}`).flex_none().px(8).py(3).rounded(6).bg(L.chip).text_size(11.5).text_color(L.muted).cursor_pointer()
          .hover((s) => s.text_color(L.text))
          .on_click((_e, cx) => { this.showQuoted[key] = true; cx.notify(); })
          .child(`··· quoted text (${part.lines} line${part.lines === 1 ? "" : "s"})`);
      }));
  }

  // Ask your mail: one line at the bottom; the answer opens above it.
  renderAsk(L) {
    const a = this.answer;
    const scope = this.account ? this.label(this.account) : "all but anon accounts";
    return v_flex().flex_none().px(10).pb(10).gap(6)
      .when(Boolean(a), (el) => el.child(this.card(L).px(14).py(10).gap(6).max_h(260)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(10.5).font_semibold().text_color(L.accent).child("ASK"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(L.dim).child(a.question))
          .child(div().id("mk-close").px(4).text_color(L.dim).cursor_pointer().hover((s) => s.text_color(L.text)).on_click((_e, cx) => { this.answer = null; cx.notify(); }).child("×")))
        .child(a.loading ? div().text_size(12.5).text_color(L.dim).child("Asking your mail…")
          : a.error ? div().text_size(12.5).text_color(a.error.kind === "unsupported" ? L.warn : L.bad).child(failureText(a.error))
            : div().id("mk-answer").overflow_y_scrollbar().child(TextView.markdown("mk-text", plainToMarkdown(a.text)).selectable(true).text_size(12.8).text_color(L.text).on_link_click(() => {})))
        .when(!a.loading && !a.error && a.sources.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6)
          .children(a.sources.map((s, i) => {
            const key = `${s.account}/${s.thread}`;
            const row = this.rows.find((x) => x.key === key);
            return div().id(`mk-src-${i}`).px(7).h(20).flex().items_center().rounded(5).bg(L.chip).text_size(11).text_color(L.muted).cursor_pointer()
              .hover((x) => x.text_color(L.text))
              .on_click((_e, cx) => { this.select(key, cx, true); cx.notify(); })
              .child(row ? row.subject : key);
          }))))))
      .child(h_flex().id("mk-box").h(32).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(L.cinput).bg(L.cbg).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().flex_none().text_size(10.5).font_semibold().text_color(L.caccent).child("AI"))
        .child(Input.new(this.askState).flex_1().h_full().text_size(12.5).text_color(L.ctext))
        .child(div().flex_none().text_size(10.5).text_color(L.cdim).child(`${scope} · a`)));
  }

  renderFailure(L) {
    const f = this.failure;
    const lines = [failureText(f)];
    let buttons = [];
    if (f.kind === "daemon") {
      lines.push("It owns the mail: it syncs, stores and runs the AI. Lumbridge Mail starts it when you open the app; or start it here.");
      buttons = this.confirmStart
        ? [this.button(L, "mx-start-yes", `Start lumbridge-maild on ${this.machine ?? "this computer"}`, (_e, cx) => this.start(cx), { primary: true }),
           this.button(L, "mx-start-no", "Cancel", (_e, cx) => { this.confirmStart = false; cx.notify(); })]
        : [this.button(L, "mx-start", "Start the mail daemon", (_e, cx) => { this.start(cx); cx.notify(); }, { primary: true }),
           this.button(L, "mx-app", "Open Lumbridge Mail", () => this.openApp())];
    } else if (f.kind === "missing") {
      lines.push("Lumbridge Mail (lumbridge-mail, lumbridge-maild, lbmail) isn't installed here. Its README says how to install it.");
      buttons = [this.button(L, "mx-install", "How to install", (_e, cx) => cx.open_url(INSTALL_URL), { primary: true })];
    } else {
      buttons = [this.button(L, "mx-retry", "Try again", (_e, cx) => this.refresh(cx), { primary: true })];
    }
    return v_flex().flex_1().min_h(0).px(10).pb(10)
      .child(this.card(L).p(18).gap(10)
        .children(lines.map((l, i) => div().text_size(i ? 12.5 : 14).when(i === 0, (el) => el.font_semibold()).text_color(i ? L.muted : L.text).child(l)))
        .child(h_flex().flex_wrap().gap(8).pt(4).children(buttons))
        .child(div().pt(6).text_size(11).text_color(L.dim).child(`Looking again every ${Math.round(DOWN_POLL_MS / 1000)} s.`)));
  }

  renderNoAccounts(L) {
    return v_flex().flex_1().min_h(0).px(10).pb(10)
      .child(this.card(L).p(18).gap(10)
        .child(div().text_size(14).font_semibold().child("No mail accounts yet."))
        .child(div().text_size(12.5).text_color(L.muted).child("Add one in Lumbridge Mail (it also offers made-up demo mail), or with lbmail account add in a terminal (it asks; a new Gmail account starts read-only)."))
        .child(h_flex().gap(8).pt(4)
          .child(this.button(L, "mn-app", "Open Lumbridge Mail", () => this.openApp(), { primary: true }))
          .child(this.button(L, "mn-term", "lbmail account add (terminal)", () => this.terminal("lbmail account add", "Mail setup")))));
  }
}
