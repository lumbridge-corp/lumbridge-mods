// node tests/mail-logic.test.mjs
// lumbridge-mail's rules against made-up mail: tests/fixtures/lbmail/ (captured from lumbridge-maild's demo
// provider, no real mail) and fake-lbmail.mjs, which answers the same arguments the pane sends.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRun, startFailure, failureText, listArgs, actArgs, draftArgs, askArgs, tailArgs, args, accountList, accountState,
  categoryCounts, threadRow, shortTime, splitQuoted, plainToMarkdown, messageView, headline, nextRefreshDelay, MIN_REFRESH_MS, CATEGORIES,
  statusAccounts, daemonState, threadList, messageList, paneFailure, tailCommand, tailStop, tailTag, tailEvent,
} from "../mods/lumbridge-mail/logic.js";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "fixtures", "lbmail");
const fx = (f) => JSON.parse(readFileSync(join(FX, f), "utf8"));
const FAKE = join(FX, "fake-lbmail.mjs");
// Runs the fake exactly as the pane's exec would (a {code, stdout, stderr} result).
function lbmail(a, mode = "ok") {
  const r = spawnSync(process.execPath, [FAKE, ...a], { encoding: "utf8", env: { ...process.env, FAKE_LBMAIL_MODE: mode } });
  return parseRun({ code: r.status, stdout: r.stdout, stderr: r.stderr });
}

// ---- every call is an agent's, as JSON
assert.deepEqual(args("status"), ["--json", "--agent", "status"]);
assert.deepEqual(listArgs({}), ["--json", "--agent", "ls", "--limit", "50"]);
assert.deepEqual(listArgs({ account: "demo-work", unread: true, category: "notification", limit: 10 }),
  ["--json", "--agent", "ls", "--account", "demo-work", "--unread", "--category", "notification", "--limit", "10"]);
assert.deepEqual(listArgs({ query: " Q4 ", unread: true }), ["--json", "--agent", "search", "Q4 is:unread", "--limit", "50"]);
assert.deepEqual(tailArgs(240), ["--json", "--agent", "tail", "--count", "1", "--timeout", "240"]);
assert.deepEqual(askArgs("what needs a reply", "demo-anon"), ["--json", "--agent", "ask", "what needs a reply", "--account", "demo-anon"]);
assert.deepEqual(draftArgs({ account: "demo-work", id: "t-q4" }, ""), ["--json", "--agent", "draft", "demo-work/t-q4", "A short, friendly reply.", "--save"]);
// Never a send: no builder can produce one.
for (const a of [listArgs({}), draftArgs({ account: "a", id: "b" }, "send it now"), askArgs("send")]) assert.ok(!a.includes("send") || a[2] !== "send");

// ---- parsing lbmail's results and failures
assert.deepEqual(parseRun({ code: 0, stdout: "[]", stderr: "" }), { ok: true, data: [] });
const down = parseRun({ code: 3, stdout: "", stderr: '{"error":{"kind":"offline","detail":"no daemon at /run/user/1000/lumbridge-mail/maild.sock (No such file or directory (os error 2)); start lumbridge-maild"}}' });
assert.equal(down.kind, "daemon");
assert.match(failureText(down), /isn't running/);
assert.equal(parseRun({ code: 3, stdout: "", stderr: '{"error":{"kind":"offline","detail":"imap.example: timed out"}}' }).kind, "offline");
assert.equal(parseRun({ code: 127, stdout: "", stderr: "bash: lbmail: command not found" }).kind, "missing");
assert.equal(parseRun({ code: 4, stdout: "", stderr: '{"error":{"kind":"refused","detail":"account demo-ro is read-only: nothing is changed on the server"}}' }).kind, "refused");
assert.equal(parseRun({ code: 0, stdout: "not json", stderr: "" }).ok, false);
assert.equal(startFailure(new Error("cannot start lbmail: No such file or directory")).kind, "missing");
assert.match(failureText({ kind: "unsupported", detail: "AI is off in the config" }), /AI is off/);

// ---- accounts: colour, state, unread, read-only, anon
const accounts = accountList(fx("accounts.json"), fx("status-trouble.json"), { "demo-work": 5 });
const by = Object.fromEntries(accounts.map((a) => [a.id, a]));
assert.equal(by["demo-work"].color, "#eb6834", "the config's colour wins");
assert.match(by["demo-anon"].color, /^#[0-9a-f]{6}$/, "no colour: one from the fallback order");
assert.equal(by["demo-work"].state, "paused", "a sign-in error pauses the sync loop");
assert.equal(by["demo-personal"].state, "offline");
assert.equal(by["demo-ro"].readonly, true);
assert.equal(by["demo-anon"].anon, true);
assert.equal(by["demo-work"].unread, 5);
assert.equal(accountState(undefined).state, "unknown");
assert.equal(accountState({ account: "x", online: true, last_sync: 1, queued: 2, error: null }).queued, 2);
const h = headline({ accounts });
assert.equal(h.word, "warn");
assert.match(h.text, /Work paused \(sign-in needed\)/);
assert.match(h.text, /Personal offline/);
assert.equal(headline({ failure: down }).word, "stopped");
assert.equal(headline({ accounts: [] }).text, "No mail accounts yet.");

// ---- counts
const c = categoryCounts(fx("counts.json"));
assert.equal(c.by.notification.unread, 4);
assert.ok(c.unread >= c.by.notification.unread);
for (const k of Object.keys(c.by)) assert.ok(CATEGORIES.includes(k), `${k} is a known category`);

// ---- rows: sensitive mail keeps only its fixed line
const okAccounts = Object.fromEntries(accountList(fx("accounts.json"), fx("status.json")).map((a) => [a.id, a]));
const rows = fx("ls.json").threads.map((t) => threadRow(t, okAccounts));
const code = rows.find((r) => r.category === "sensitive");
assert.ok(code, "the fixtures hold one sensitive thread");
assert.equal(code.subject, "A security code from Acme");
assert.equal(code.summary, "");
assert.equal(code.snippet, "");
assert.equal(code.sender, "");
const q4 = rows.find((r) => r.key === "demo-work/t-q4");
assert.equal(q4.sender, "Priya Raman");
assert.equal(q4.color, "#eb6834");
assert.equal(q4.unread, true);
assert.equal(rows.find((r) => r.key === "demo-ro/t-q4").readonly, true);
assert.ok(rows.every((r) => r.account !== "demo-anon"), "the unified inbox leaves anon accounts out");

// ---- time
const NOW = Date.parse("2026-11-10T15:00:00");
assert.match(shortTime(Date.parse("2026-11-10T09:05:00") / 1000, NOW), /^09:05$/);
assert.equal(shortTime(Date.parse("2026-11-08T09:05:00") / 1000, NOW), "Sun");
assert.equal(shortTime(Date.parse("2026-10-01T09:05:00") / 1000, NOW), "1 Oct");
assert.equal(shortTime(Date.parse("2025-10-01T09:05:00") / 1000, NOW), "1 Oct 2025");
assert.equal(shortTime(0, NOW), "");

// ---- the reader: quoted text folds, plain text stays plain
let parts = splitQuoted("Yes, I'll take docs.\n\nOn Mon 9 Nov 2026 at 09:00, Sam <sam@work.example> wrote:\n> one\n> two");
assert.deepEqual(parts.map((p) => p.quoted), [false, true]);
assert.equal(parts[1].lines, 3);
parts = splitQuoted("Top\n> a\n> b\nmiddle\n> lone quote stays inline\nend");
assert.deepEqual(parts.map((p) => [p.quoted, p.text]), [[false, "Top"], [true, "> a\n> b"], [false, "middle\n> lone quote stays inline\nend"]]);
assert.deepEqual(splitQuoted(""), []);
const launch = fx("show/demo-work_t-launch.json").map(messageView);
assert.equal(launch.length, 2);
assert.ok(launch[1].parts.some((p) => p.quoted), "the fixture's reply folds its quote");
const md = plainToMarkdown("# not a heading\n[link](https://evil.example) *x* <b>html</b>\n    indented");
assert.ok(md.startsWith("\\# not a heading"), md);
assert.ok(md.includes("\\[link\\]\\(https\\:\\/\\/evil\\.example\\)"), "no link can be made out of mail");
assert.ok(md.includes("\\<b\\>"), "no HTML either");
assert.ok(md.includes("\\\n    indented"), "line breaks are hard breaks; indentation is kept, never a code block");
const sens = fx("show/demo-personal_t-acme-code.json").map(messageView)[0];
assert.equal(sens.sensitive, true);
assert.deepEqual(sens.parts.map((p) => p.text), ["A security code from Acme"]);

// ---- refresh pacing: never under 15 s between event-driven refreshes
assert.equal(nextRefreshDelay(0, 100000), 0);
assert.equal(nextRefreshDelay(100000, 105000), MIN_REFRESH_MS - 5000);
assert.ok(MIN_REFRESH_MS >= 15000);

// ---- the same calls against the fake lbmail
let r = lbmail(listArgs({ account: "demo-work", unread: true }));
assert.ok(r.ok && r.data.threads.length > 0 && r.data.threads.every((t) => t.account === "demo-work" && t.unread_count > 0));
r = lbmail(listArgs({ account: "demo-anon" }));
assert.ok(r.ok && r.data.threads.length > 0 && r.data.threads.every((t) => t.account === "demo-anon"), "anon only when named");
r = lbmail(listArgs({ query: "Q4" }));
assert.ok(r.ok && r.data.threads.every((t) => /Q4/.test(t.subject)));
r = lbmail(actArgs("star", { account: "demo-work", id: "t-q4", flagged: true, unread_count: 1 }));
assert.ok(r.ok && r.data[0].queued);
r = lbmail(actArgs("archive", { account: "demo-ro", id: "t-q4" }));
assert.equal(r.kind, "refused");
assert.match(failureText(r), /read-only/);
r = lbmail(args("show", "demo-work/nope"));
assert.equal(r.kind, "not_found");
r = lbmail(draftArgs({ account: "demo-work", id: "t-q4" }, "say yes"));
assert.ok(r.ok && r.data.subject.startsWith("Re:"));
r = lbmail(draftArgs({ account: "demo-personal", id: "t-acme-code" }, "reply"));
assert.equal(r.kind, "refused", "sensitive mail never goes to a model");
assert.equal(lbmail(askArgs("anything"), "noai").kind, "unsupported");
assert.equal(lbmail(args("status"), "down").kind, "daemon");
r = lbmail(args("accounts"), "empty");
assert.deepEqual(r.data, []);
r = lbmail(tailArgs(1));
assert.ok(r.ok && r.data === null, "a quiet tail ends with no event and exit 0");

// ---- the shapes a running lumbridge-maild 0.1.0 prints (tests/fixtures/lbmail/real/: its keys and types, invented values)
const rx = (f) => fx(join("real", f));
const realStatus = rx("status.json");
assert.ok(!Array.isArray(realStatus) && Array.isArray(realStatus.accounts), "status is {accounts, daemon, via, person}, not a list");
assert.equal(statusAccounts(realStatus).length, 4);
assert.deepEqual(statusAccounts(realStatus.accounts), realStatus.accounts, "the rows alone (an older daemon) are taken too");
for (const odd of [null, undefined, "x", 3, {}, { accounts: null }, { accounts: "no" }]) assert.deepEqual(statusAccounts(odd), [], "anything else is no rows, never a throw");
assert.deepEqual(daemonState(realStatus), { paused: false, version: "0.1.0", via: "remote:mailhost" });
assert.equal(daemonState({ ...realStatus, daemon: { ...realStatus.daemon, paused: true } }).paused, true);
assert.deepEqual(daemonState(realStatus.accounts), { paused: false, version: null, via: null });
assert.deepEqual(daemonState({ accounts: [], daemon: null, via: "local:/x", person: false }), { paused: false, version: null, via: "local:/x" }, "an older daemon has no daemon.info");

const realAccounts = accountList(rx("accounts.json"), realStatus, { gmail: 7 });
assert.deepEqual(realAccounts.map((a) => a.id), ["gmail", "gmail-two", "resend-acme", "zoho"]);
assert.ok(realAccounts.every((a) => a.state === "online" && a.readonly && !a.anon), "every account online and read-only, as the real ones are");
assert.equal(realAccounts[0].unread, 7);
assert.equal(realAccounts[0].color, "#4f8cff");
assert.equal(realAccounts[2].persona, "work");
// The call that hung the pane: accountList given status as lbmail prints it.
assert.doesNotThrow(() => accountList(rx("accounts.json"), realStatus));
for (const odd of [null, {}, "x", { accounts: 5 }]) assert.doesNotThrow(() => accountList(rx("accounts.json"), odd));
assert.deepEqual(accountList(null, realStatus), []);
assert.deepEqual(accountList({ not: "a list" }, realStatus), []);
let rh = headline({ accounts: realAccounts, live: true });
assert.equal(rh.word, "ok");
assert.match(rh.text, /^4 accounts · 4 read-only · live$/);
rh = headline({ accounts: realAccounts, paused: true });
assert.equal(rh.word, "warn");
assert.match(rh.text, /daemon paused/);
assert.equal(headline({ accounts: [], loaded: false }).text, "Reading your mail…");
assert.equal(headline({ accounts: [], loaded: true }).text, "No mail accounts yet.");

const realCounts = categoryCounts(rx("counts.json"));
assert.equal(Object.keys(realCounts.by).length, 9);
assert.equal(realCounts.unread, 53);
for (const k of Object.keys(realCounts.by)) assert.ok(CATEGORIES.includes(k), `${k} is a known category`);
for (const odd of [null, {}, "x"]) assert.equal(categoryCounts(odd).unread, 0);

const realById = Object.fromEntries(realAccounts.map((a) => [a.id, a]));
const realList = rx("ls.json");
assert.equal(typeof realList.next, "string", "ls carries a cursor beside the threads");
const realRows = threadList(realList).map((t) => threadRow(t, realById));
assert.equal(realRows.length, 6);
assert.deepEqual(threadList(realList.threads), realList.threads);
for (const odd of [null, {}, { threads: null }, "x"]) assert.deepEqual(threadList(odd), []);
assert.deepEqual(threadList(rx("search-none.json")), [], "a search with no match is {threads: [], next: null}");
assert.ok(realRows.every((r) => r.key === `${r.account}/${r.id}` && r.readonly && r.color.startsWith("#") && r.date > 0));
assert.equal(realRows.find((r) => r.account === "gmail-two").sender, "billing@harborline.example", "a sender with no name (name: null) shows its address");
assert.equal(realRows[0].sender, "Priya Raman");
const two = realRows.find((r) => r.raw.participants.length === 2);
assert.equal(two.sender, "alerts@ops.example +1");
assert.equal(typeof two.due, "number", "a due date is Unix seconds");
const realSens = realRows.find((r) => r.sensitive);
assert.equal(realSens.subject, "Bank or money mail from Northbank");
assert.equal(realSens.sender, "", "the daemon still names the sender of sensitive mail; the row does not show it");
assert.equal(realSens.summary, "");
assert.equal(realSens.snippet, "");
assert.doesNotThrow(() => threadRow({ id: "x", account: "gmail" }), "a thread with nothing but its ids still makes a row");
assert.doesNotThrow(() => threadRow({ id: "x", account: "gmail", participants: null, triage: null }));

const realThread = messageList(rx("show-thread.json"));
assert.equal(realThread.length, 3);
assert.equal(realThread[0].from, "priya@work.example");
assert.deepEqual(realThread[0].parts.map((p) => p.quoted), [false, true], "quoted history folds");
assert.ok(realThread.every((m) => typeof m.id === "string" && m.date > 0 && !m.sensitive && !m.suspicious));
const realSusp = messageList(rx("show-suspicious.json"))[0];
assert.equal(realSusp.suspicious, true);
assert.equal(realSusp.why.length, 2);
assert.equal(realSusp.from, "Brightdesk <news@brightdesk.example>");
const realSensMsg = messageList(rx("show-sensitive.json"))[0];
assert.equal(realSensMsg.sensitive, true);
assert.deepEqual(realSensMsg.parts.map((p) => p.text), ["Bank or money mail from Northbank"]);
const realAtt = messageList(rx("show-attachment.json"));
assert.deepEqual(realAtt[0].attachments, ["invoice-1042.pdf (application/pdf, 48211 bytes)"], "an attachment is one printed line");
assert.deepEqual(messageView({ id: "m", attachments: [{ name: "a.pdf" }, {}] }).attachments, ["a.pdf", "attachment"]);
for (const odd of [null, {}, "x", { messages: [] }]) assert.deepEqual(messageList(odd), []);
assert.doesNotThrow(() => messageView({ id: "m" }));

// ---- a failure inside the pane is shown, never a hang
const pf = paneFailure(new TypeError("(status ?? []).map is not a function"));
assert.equal(pf.kind, "pane");
assert.match(failureText(pf), /could not read lbmail's answer \(\(status \?\? \[\]\)\.map is not a function\)/);
assert.equal(headline({ failure: pf }).word, "error");

// ---- tail events, one JSON line each
const events = readFileSync(join(FX, "real", "events.jsonl"), "utf8").trim().split("\n").map((l) => parseRun({ code: 0, stdout: l, stderr: "" }));
assert.deepEqual(events.map((e) => tailEvent(e.data).type), ["changed", "new_mail", "status"]);
assert.deepEqual(events.map((e) => tailEvent(e.data).account), ["gmail", "zoho", "gmail"]);
assert.equal(tailEvent(null), null, "a tail that timed out is no event");
assert.equal(tailEvent({ type: "something_new" }).type, "something_new", "an event kind this pane does not know still refreshes");

// ---- status as the fake prints it now (the real shape), and as an older daemon did
r = lbmail(args("status"));
assert.ok(r.ok && !Array.isArray(r.data) && statusAccounts(r.data).length === 4);
assert.equal(statusAccounts(lbmail(args("status"), "oldstatus").data).length, 4);
assert.equal(daemonState(lbmail(args("status"), "paused").data).paused, true);
assert.equal(accountList(lbmail(args("accounts")).data, lbmail(args("status"), "trouble").data).find((a) => a.id === "demo-work").state, "paused");
assert.deepEqual(statusAccounts(lbmail(args("status"), "empty").data), []);

// ---- the waiting tail can be ended: a closed pane leaves no lbmail tail behind
assert.equal(tailTag("ab-1/2 c"), "lumbridge-mail-tail-ab12c");
const quick = tailCommand("quick1", [process.execPath, FAKE], 1);
assert.equal(quick.cmd, "sh");
assert.deepEqual(quick.args.slice(2), ["lumbridge-mail-tail-quick1", process.execPath, FAKE, "--json", "--agent", "tail", "--count", "1", "--timeout", "1"]);
let q = spawnSync(quick.cmd, quick.args, { encoding: "utf8" });
assert.deepEqual(parseRun({ code: q.status, stdout: q.stdout, stderr: q.stderr }), { ok: true, data: null }, "through the wrapper a quiet tail is still exit 0 and no output");
q = spawnSync("sh", [...tailCommand("gone1", ["lbmail-that-is-not-installed"], 1).args], { encoding: "utf8" });
assert.equal(parseRun({ code: q.status, stdout: q.stdout, stderr: q.stderr }).kind, "missing", "lbmail missing is still seen through the wrapper");
const downLine = "echo '{\"error\":{\"kind\":\"offline\",\"detail\":\"no daemon at /x; start lumbridge-maild\"}}' >&2; exit 3";
const wrapped = tailCommand("down1", ["sh", "-c", downLine], 1);
q = spawnSync(wrapped.cmd, wrapped.args, { encoding: "utf8" });
assert.equal(parseRun({ code: q.status, stdout: q.stdout, stderr: q.stderr }).kind, "daemon", "exit code and stderr pass through the wrapper");

const token = `test${process.pid}x${Date.now().toString(36)}`;
const long = tailCommand(token, [process.execPath, FAKE], 120);
const alive = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
const child = spawn(long.cmd, long.args, { stdio: "ignore" });
const ended = new Promise((ok) => child.on("exit", (code, signal) => ok({ code, signal })));
await new Promise((ok) => setTimeout(ok, 700));
assert.ok(alive(tailTag(token)).length >= 1, "the waiting tail runs under its tag");
assert.ok(alive(`${FAKE}.*--timeout 120`).length >= 1, "and lbmail runs under it");
const stop = tailStop(token);
assert.deepEqual([stop.cmd, ...stop.args], ["pkill", "-TERM", "-f", tailTag(token)]);
const t0 = Date.now();
assert.equal(spawnSync(stop.cmd, stop.args).status, 0);
const end = await Promise.race([ended, new Promise((ok) => setTimeout(() => ok(null), 5000))]);
assert.ok(end, "the wrapper ends when told to (it would have waited 120 s)");
assert.ok(Date.now() - t0 < 5000);
await new Promise((ok) => setTimeout(ok, 300));
assert.deepEqual(alive(tailTag(token)), [], "nothing left under the tag");
assert.deepEqual(alive(`${FAKE}.*--timeout 120`), [], "and lbmail tail itself is gone");
assert.notEqual(spawnSync(stop.cmd, stop.args).status, 0, "stopping again finds nothing (and is harmless)");

// ---- and it ends by itself when whoever started it is gone (an app that quit, `lumbridge-app check`)
const token2 = `orph${process.pid}x${Date.now().toString(36)}`;
const orphan = tailCommand(token2, [process.execPath, FAKE], 119);
// A parent that starts the wrapper, lives a second and goes without ending it, as a checker that never calls close() does.
spawnSync("sh", ["-c", 'sh "$@" >/dev/null 2>&1 & sleep 1', "parent", ...orphan.args]);
assert.ok(alive(`${FAKE}.*--timeout 119`).length >= 1, "the orphaned tail started");
let left = ["?"];
for (let i = 0; i < 40 && left.length; i++) { await new Promise((ok) => setTimeout(ok, 250)); left = alive(`${FAKE}.*--timeout 119`); }
spawnSync("pkill", ["-f", tailTag(token2)]); // whatever the outcome, leave nothing behind
assert.deepEqual(left, [], "an orphaned tail ends within a few seconds, not its 119 s");

console.log("mail-logic: ok");
