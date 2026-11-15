#!/usr/bin/env node
// A stand-in for `lbmail --json` that answers from the made-up mail in this folder (captured from
// lumbridge-maild's demo provider: no real mail, no network). For tests and the sandbox screenshot.
//
//   node fake-lbmail.mjs --json --agent ls --account demo-work
//
// Mode: $FAKE_LBMAIL_MODE, else the first word of ./mode next to this file, else "ok":
//   ok        every account online, AI on
//   trouble   one account offline, one paused (sign-in needed)
//   down      no daemon (exit 3, as lbmail prints it)
//   empty     a daemon with no accounts
//   noai      AI off in the config (ask/draft are "unsupported")
//   paused    the daemon is paused (lbmail pause): status says so
//   oldstatus status as a daemon before daemon.info printed it (the account rows alone)
// Actions answer as lbmail does ({thread, queued}) and change nothing; read-only accounts refuse.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(here, f), "utf8"));
const modeFile = join(here, "mode");
const mode = process.env.FAKE_LBMAIL_MODE || (existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim().split(/\s+/)[0] : "") || "ok";

const argv = process.argv.slice(2).filter((a) => a !== "--json" && a !== "--agent");
const [cmd, ...rest] = argv;
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const opts = (name) => rest.flatMap((a, i) => (a === name ? [rest[i + 1]] : []));
const has = (name) => rest.includes(name);
const positional = () => rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--") && !["--unread", "--save", "--off", "--all"].includes(rest[i - 1])));

const out = (v) => { process.stdout.write(JSON.stringify(v, null, 2) + "\n"); process.exit(0); };
const fail = (code, kind, detail) => { process.stderr.write(JSON.stringify({ error: { kind, detail } }) + "\n"); process.exit(code); };

if (mode === "down") fail(3, "offline", "no daemon at /run/user/1000/lumbridge-mail/maild.sock (No such file or directory (os error 2)); start lumbridge-maild");

const accounts = mode === "empty" ? [] : read("accounts.json");
const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
const all = mode === "empty" ? [] : read("ls.json").threads;
const anon = mode === "empty" ? [] : read("ls-demo-anon.json").threads;

function threadsFor(list) {
  return list.length ? [...all, ...anon].filter((t) => list.includes(t.account)) : all; // the anon wall: only when named
}
function threadOf(r) {
  const [account, id] = String(r ?? "").split("/");
  if (!account || !id) fail(2, "invalid", `"${r}": give a thread as account/thread`);
  const t = [...all, ...anon].find((x) => x.account === account && x.id === id);
  if (!t) fail(5, "not_found", `thread ${r}`);
  return t;
}

switch (cmd) {
  case "status": {
    // As lbmail prints it since daemon.info: the per-account rows inside {accounts, daemon, via, person}.
    // Mode "oldstatus" prints the rows alone, as a daemon before that did.
    const rows = mode === "empty" ? [] : read(mode === "trouble" ? "status-trouble.json" : "status.json");
    if (mode === "oldstatus") out(rows);
    out({ accounts: rows, daemon: { version: "0.0.0-fake", paused: mode === "paused", load: [], kept_accounts: [] }, via: "local:/run/user/1000/lumbridge-mail/maild.sock", person: false });
  }
  case "accounts": out(accounts);
  case "counts": {
    const a = opts("--account");
    if (a.length === 1 && existsSync(join(here, `counts-${a[0]}.json`))) out(read(`counts-${a[0]}.json`));
    out(mode === "empty" ? [] : read("counts.json"));
  }
  case "ls": {
    let list = threadsFor(opts("--account"));
    if (has("--unread")) list = list.filter((t) => t.unread_count > 0);
    const c = opt("--category");
    if (c) list = list.filter((t) => t.triage?.category === c);
    out({ threads: list.slice(0, Number(opt("--limit") ?? 30)), next: null });
  }
  case "search": {
    const q = positional().join(" ").toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
    const list = threadsFor(opts("--account")).filter((t) => q.every((w) => `${t.subject} ${t.snippet}`.toLowerCase().includes(w)));
    out({ threads: list.slice(0, Number(opt("--limit") ?? 20)), next: null });
  }
  case "show": {
    const t = threadOf(rest[0]);
    const f = `show/${t.account}_${t.id}.json`;
    if (existsSync(join(here, f))) out(read(f));
    out([{ id: "m1", from: t.participants[0]?.email ?? "", date: t.date, subject: t.subject, text: t.snippet, attachments: [], sensitive: false }]);
  }
  case "archive": case "trash": case "star": case "read": {
    const refs = positional();
    if (!refs.length) fail(2, "invalid", "name at least one thread (account/thread)");
    const res = refs.map((r, i) => {
      const t = threadOf(r);
      if (byId[t.account]?.readonly) fail(4, "refused", `account ${t.account} is read-only: nothing is changed on the server`);
      return { thread: r, queued: 100 + i };
    });
    out(res);
  }
  case "draft": {
    if (mode === "noai") fail(1, "unsupported", "AI is off in the config");
    const t = threadOf(rest[0]);
    if (t.triage?.category === "sensitive") fail(4, "refused", "sensitive mail is never given to a model");
    out(read("draft.json"));
  }
  case "ask": {
    if (mode === "noai") fail(1, "unsupported", "AI is off in the config");
    out(read("ask.json"));
  }
  case "tail": {
    // No events from fixtures: wait out the timeout, print nothing, exit 0 (as lbmail does).
    const s = Math.min(Number(opt("--timeout") ?? 1), 600);
    setTimeout(() => process.exit(0), s * 1000);
    break;
  }
  case "--version": case "-V": process.stdout.write("lbmail 0.0.0-fake\n"); process.exit(0);
  default: fail(2, "invalid", `unknown command ${cmd}`);
}
