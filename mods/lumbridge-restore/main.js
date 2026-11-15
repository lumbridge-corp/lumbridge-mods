// Restore: Claudes that a reboot turned back into plain shells. See the repository README.
// Lists them from the labels hooks/claude-session-label.sh leaves on each terminal, and resumes
// the same conversation in the same pane, only when asked and only at an empty prompt.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, terminals, lbc, home, notify, nextCommand } from "lumbridge";
import { Poll, header, iconButton, colors, dot } from "./_kit/kit.js";
import { restorable, promptEmpty, resumeCommand, trustAnswer } from "./logic.js";

const sleep = (cx, ms) => cx.sleep(ms);
const screenOf = async (address) => (await lbc(["read", "--lines", "0", address])).stdout ?? "";

export default class Restore extends View {
  init(_props, cx) {
    this.ask = null; // addresses waiting for a yes
    this.running = false;
    this.results = new Map(); // address -> { state: "working"|"done"|"needs-you"|"refused", why }
    // Screens only, for "can we type there?". terminals() itself is live.
    this.screens = new Poll(async () => {
      const out = {};
      await Promise.all(this.rows().map(async (t) => {
        out[t.address] = await screenOf(t.address).catch(() => null);
      }));
      return out;
    }, 15000);
    this.screens.start(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.screens.refresh(cx);
        else if (c === "restore-all") this.ask = this.ready().map((t) => t.address);
        else if (c.startsWith("restore:")) this.ask = [c.slice(8)];
        else if (c === "confirm") this.confirm(cx);
        else if (c === "cancel") this.ask = null;
        cx.notify();
      }
    });
  }

  rows() {
    return terminals().filter(restorable);
  }

  /** May we type there right now, as far as the last look says? */
  canType(t) {
    return promptEmpty(this.screens.data?.[t.address]) && resumeCommand(t.labels) !== null;
  }

  ready() {
    return this.rows().filter((t) => this.canType(t));
  }

  confirm(cx) {
    const list = this.ask;
    this.ask = null;
    if (!list?.length || this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      let done = 0, attention = 0;
      for (const address of list) {
        const r = await this.restoreOne(address, cx).catch((e) => ({ state: "refused", why: String(e?.message ?? e) }));
        this.results.set(address, r);
        if (r.state === "done") done += 1; else attention += 1;
        cx.notify();
        await sleep(cx, 1500); // one at a time: a dozen Claudes starting together is a lot
      }
      this.running = false;
      notify({ title: "Restore", body: `${done} resumed${attention ? `, ${attention} need a look` : ""}`, level: attention ? "warning" : "info" });
      this.screens.refresh(cx);
      cx.notify();
    });
  }

  async restoreOne(address, cx) {
    this.results.set(address, { state: "working" });
    cx.notify();
    // Look again, right before typing: the last poll may be 15 s old.
    const t = terminals().find((x) => x.address === address);
    if (!t || !restorable(t)) return { state: "refused", why: "no longer a plain shell" };
    const command = resumeCommand(t.labels);
    if (!command) return { state: "refused", why: "its labels don't look right" };
    if (!promptEmpty(await screenOf(address))) return { state: "refused", why: "text on the prompt line, or not at a prompt" };

    const sent = await lbc(["send", address, command]);
    if (sent.code !== 0) return { state: "refused", why: `lbc send: ${(sent.stderr ?? "").trim()}` };

    for (let i = 0; i < 16; i += 1) {
      await sleep(cx, 1000);
      const now = terminals().find((x) => x.address === address);
      if (!now) return { state: "refused", why: "the terminal went away" };
      const screen = await screenOf(address);
      const trust = trustAnswer(screen, t.labels["claude.cwd"], home());
      if (trust === "answer") await lbc(["keys", address, "down", "enter"]);
      if (trust === "ask-person") return { state: "needs-you", why: "Claude asks whether to trust this folder" };
      if (now.foreground?.name === "claude" && i >= 2 && trust === "none" && /❯/.test(screen)) return { state: "done" };
    }
    const end = terminals().find((x) => x.address === address);
    return restorable(end)
      ? { state: "refused", why: "Claude didn't start, see the pane" }
      : { state: "needs-you", why: "started, but no prompt yet: see the pane" };
  }

  renderRow(t, c) {
    const th = theme();
    const r = this.results.get(t.address);
    const typed = this.screens.data && !promptEmpty(this.screens.data[t.address]);
    const bad = resumeCommand(t.labels) === null;
    const why = bad ? "labels look wrong" : typed ? "text on its prompt line" : null;
    return h_flex().id(`row-${t.address}`).h(44).flex_none().px(16).gap(10).items_center()
      .child(dot(why ? c.warn : th.idle))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(th.foreground).child(`${t.labels.where ?? "(no tab)"}  ·  ${t.address}`))
        .child(div().truncate().text_size(11.5).text_color(th.dim)
          .child(`${t.labels["claude.cwd"] ?? t.cwd}  ·  ${t.labels["claude.session"].slice(0, 8)}${r ? `  ·  ${r.state}${r.why ? `: ${r.why}` : ""}` : why ? `  ·  ${why}` : ""}`)))
      .when(!why && !this.running, (el) => el.child(iconButton(th, `restore-${t.address}`, "Restore", (_e, cx) => { this.ask = [t.address]; cx.notify(); })));
  }

  renderAsk(th) {
    const list = this.ask;
    const first = terminals().find((t) => t.address === list[0]);
    const text = list.length === 1
      ? `Type this into ${list[0]}?  ${first ? resumeCommand(first.labels) : ""}`
      : `Resume ${list.length} Claudes, one at a time, each in its own pane? Panes with text on the prompt line are skipped.`;
    return v_flex().flex_none().p(16).gap(10).bg(th.popover).border_t_1().border_color(th.border)
      .child(div().text_color(th.foreground).child(text))
      .child(h_flex().gap(8)
        .child(div().id("yes").h(28).px(12).flex().items_center().rounded(6).bg(th.solid).text_color(th.solid_foreground).cursor_pointer()
          .on_click((_e, cx) => { this.confirm(cx); cx.notify(); }).child("Resume"))
        .child(div().id("no").h(28).px(12).flex().items_center().rounded(6).border_1().border_color(th.input).cursor_pointer()
          .on_click((_e, cx) => { this.ask = null; cx.notify(); }).child("Cancel")));
  }

  render(_cx) {
    const th = theme();
    const c = colors(th);
    const rows = this.rows();
    const ready = this.ready();
    const right = h_flex().gap(4)
      .child(iconButton(th, "refresh", "↻", (_e, cx) => { this.screens.refresh(cx); }, "Look at the panes again"))
      .when(ready.length > 0 && !this.running, (el) => el.child(iconButton(th, "all", `Restore all (${ready.length})`, (_e, cx) => { this.ask = ready.map((t) => t.address); cx.notify(); })));
    const empty = div().p(16).text_color(th.dim).child("No Claude to bring back. Panes only appear here after a reboot or a crash, once their session is labeled.");
    const body = v_flex().id("list").flex_1().min_h(0).overflow_y_scroll()
      .when(rows.length === 0, (el) => el.child(empty));
    return v_flex().size_full().min_h(0).bg(th.chrome).text_size(13)
      .child(header(th, this.running ? "Restore: working…" : "Restore", right))
      .child(body.children(rows.map((t) => this.renderRow(t, c))))
      .when(Boolean(this.ask?.length), (el) => el.child(this.renderAsk(th)));
  }
}
