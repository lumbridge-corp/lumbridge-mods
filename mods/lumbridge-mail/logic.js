// Pure rules of lumbridge-mail, tested by tests/mail-logic.test.mjs (no lumbridge imports here).
//
// Everything the pane knows about mail comes from `lbmail --json --agent ...` (lumbridge-maild's CLI,
// repo lumbridge-mail). Run from a mod it is an agent: it can read (sensitive mail
// comes back as one fixed line), act (archive / star / read / trash, unless the account is read-only),
// ask the AI and save drafts, and it can never send. These functions turn its output into what the
// pane shows and its clicks into lbmail arguments. Shapes: crates/lumbridge-mail-core/src (model.rs,
// rpc.rs, ai.rs) and crates/lumbridge-maild/src/cli.rs; tests/fixtures/lbmail/ holds made-up examples.

/** The AI categories in the order the filter row shows them (lumbridge_mail_core::Category::ALL). */
export const CATEGORIES = ["important", "personal", "transactional", "newsletter", "promotion", "notification", "sensitive", "spam", "other"];

export const CATEGORY_LABEL = {
  important: "Important", personal: "Personal", transactional: "Receipts", newsletter: "Newsletters",
  promotion: "Promotions", notification: "Notifications", sensitive: "Sensitive", spam: "Spam", other: "Other",
};

/** Exit codes of lbmail (crates/lumbridge-maild/README.md, "lbmail"). */
export const EXIT = { ok: 0, other: 1, invalid: 2, offline: 3, refused: 4, not_found: 5 };

// Fallback account colours when the config gives none: the applied-research-1 series order
// (blue, orange, aqua), then two more that stay apart from red/amber/green (reserved for state).
const ACCOUNT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#8a5cd6", "#c2478f"];

/**
 * One lbmail run, `{code, stdout, stderr}` from exec, as `{ok: true, data}` or
 * `{ok: false, kind, detail, code}`. kind is lbmail's error kind (offline, refused, not_found,
 * unsupported, invalid, auth, other), or "missing" when lbmail itself can't run, or "daemon"
 * when the daemon isn't there (offline with "no daemon at ...", exit 3).
 */
export function parseRun(r) {
  if (!r) return { ok: false, kind: "missing", detail: "lbmail did not run", code: -1 };
  if (r.code === 0) {
    const out = String(r.stdout ?? "").trim();
    if (!out) return { ok: true, data: null };
    try {
      return { ok: true, data: JSON.parse(out) };
    } catch (e) {
      return { ok: false, kind: "other", detail: `lbmail printed something that isn't JSON (${String(e?.message ?? e).slice(0, 60)})`, code: 0 };
    }
  }
  const err = String(r.stderr ?? "").trim();
  if (r.code === 127 || /command not found|No such file or directory \(os error 2\)$|not found$/.test(err.split("\n").pop() ?? "")) {
    if (!/^\{/.test(err)) return { ok: false, kind: "missing", detail: "lbmail isn't installed here", code: r.code };
  }
  let kind = "other";
  let detail = err.split("\n").pop() || `lbmail exited ${r.code}`;
  const line = err.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (line) {
    try {
      const e = JSON.parse(line).error;
      if (e && typeof e === "object") {
        kind = String(e.kind ?? "other");
        detail = String(e.detail ?? detail);
      }
    } catch {}
  } else if (r.code === EXIT.offline) kind = "offline";
  else if (r.code === EXIT.refused) kind = "refused";
  else if (r.code === EXIT.not_found) kind = "not_found";
  else if (r.code === EXIT.invalid) kind = "invalid";
  if (kind === "offline" && /no daemon|start lumbridge-maild|connection refused/i.test(detail)) kind = "daemon";
  return { ok: false, kind, detail, code: r.code };
}

/** An exec that rejected (the program could not start at all). */
export function startFailure(e) {
  const m = String(e?.message ?? e);
  if (/not installed|not found|No such file|cannot start|can't start|ENOENT/i.test(m)) return { ok: false, kind: "missing", detail: "lbmail isn't installed here", code: -1 };
  if (/unreachable|offline|machine/i.test(m)) return { ok: false, kind: "machine", detail: m, code: -1 };
  if (/timed? ?out/i.test(m)) return { ok: false, kind: "timeout", detail: m, code: -1 };
  return { ok: false, kind: "other", detail: m, code: -1 };
}

/** Something in the pane itself threw (a shape it did not expect): a failure to show, never a hang. */
export function paneFailure(e) {
  return { ok: false, kind: "pane", detail: String(e?.message ?? e).slice(0, 200), code: -1 };
}

/** What the person should read for a failure, in one line. */
export function failureText(f) {
  switch (f?.kind) {
    case "missing": return "lbmail isn't installed on this computer.";
    case "daemon": return "The mail daemon (lumbridge-maild) isn't running.";
    case "machine": return `That machine can't be reached: ${f.detail}`;
    case "timeout": return "lbmail took too long to answer.";
    case "refused": return f.detail.includes("read-only") ? "This account is read-only: nothing is changed on the server." : `Refused: ${f.detail}`;
    case "unsupported": return f.detail.includes("AI is off") ? "AI is off in Lumbridge Mail's config." : `Not supported: ${f.detail}`;
    case "not_found": return "That mail is no longer there.";
    case "auth": return `Sign-in needed: ${f.detail}`;
    case "offline": return `Offline: ${f.detail}`;
    case "pane": return `The Mail pane could not read lbmail's answer (${f.detail}).`;
    default: return f?.detail ?? "Something went wrong.";
  }
}

// ---------------------------------------------------------------- lbmail arguments

/** `account/thread`, the reference every lbmail thread command takes. */
export const ref = (t) => `${t.account}/${t.id}`;

/** The arguments of one call. Every call is `--json --agent` (never a person, even if it had a TTY). */
export function args(...rest) {
  return ["--json", "--agent", ...rest.flat().filter((a) => a !== null && a !== undefined && a !== "")];
}

/** The thread list for the filter: `ls` or, with a query, `search` (search has no category/unread). */
export function listArgs(f = {}) {
  const limit = String(f.limit ?? 50);
  const accounts = f.account ? ["--account", f.account] : [];
  if (f.query && f.query.trim()) {
    const words = [f.query.trim()];
    if (f.unread && !/\bis:unread\b/.test(f.query)) words.push("is:unread");
    if (f.category && f.category !== "all") words.push(`category:${f.category}`); // ignored by the store if unknown
    return args("search", words.join(" "), accounts, "--limit", limit);
  }
  return args("ls", accounts, f.unread ? "--unread" : null, f.category && f.category !== "all" ? ["--category", f.category] : null, "--limit", limit);
}

/** archive / star / read / trash for a thread row; star and read toggle (with `--off`). */
export function actArgs(action, t) {
  switch (action) {
    case "archive": return args("archive", ref(t));
    case "trash": return args("trash", ref(t));
    case "star": return args("star", ref(t), t.flagged ? "--off" : null);
    case "read": return args("read", ref(t), t.unread_count > 0 ? null : "--off");
    default: throw new Error(`no action ${action}`);
  }
}

export const DEFAULT_DRAFT = "A short, friendly reply.";

/** An AI reply draft, saved as a draft (lbmail never sends; the person sends from Lumbridge Mail). */
export function draftArgs(t, instruction) {
  return args("draft", ref(t), String(instruction || DEFAULT_DRAFT).trim() || DEFAULT_DRAFT, "--save");
}

/** "Ask your mail", limited to one account when the filter names one (anon accounts are only read when named). */
export function askArgs(question, account = null) {
  return args("ask", String(question).trim(), account ? ["--account", account] : null);
}

/** Waits for one event from the daemon, at most `seconds` (lbmail tail --count 1 --timeout S). */
export function tailArgs(seconds = 240) {
  return args("tail", "--count", "1", "--timeout", String(seconds));
}

/** The name a copy's waiting tail runs under, so that copy (and only it) can end it when it closes. */
export const tailTag = (token) => `lumbridge-mail-tail-${String(token).replace(/[^A-Za-z0-9]/g, "")}`;

/**
 * The tail as a command that can be ended: `sh` named by the tag runs lbmail, passes on its output
 * and exit code, and ends lbmail when it is told to stop. exec has no cancel, so a closed pane ends
 * its tail with tailStop (else it would wait out its timeout, up to 4 minutes).
 * `lbmail` is the argv prefix (["lbmail"], or a test's fake).
 */
export function tailCommand(token, lbmail = ["lbmail"], seconds = 240) {
  // The watcher ends lbmail when whoever started this sh is gone (the app quit or crashed, or it was
  // `lumbridge-app check`, which never calls close()); it looks every 2 s and holds no output open.
  const script = '"$@" & p=$!; trap \'kill "$p" 2>/dev/null\' TERM INT HUP; '
    + '(while kill -0 "$PPID" 2>/dev/null && kill -0 "$p" 2>/dev/null; do sleep 2; done; kill "$p" 2>/dev/null) >/dev/null 2>&1 & '
    + 'wait "$p"; c=$?; kill "$p" 2>/dev/null; exit "$c"';
  return { cmd: "sh", args: ["-c", script, tailTag(token), ...lbmail.map(String), ...tailArgs(seconds)] };
}

/** Ends that copy's waiting tail (pkill matches the tag in the sh's own command line; no match is fine). */
export function tailStop(token) {
  return { cmd: "pkill", args: ["-TERM", "-f", tailTag(token)] };
}

/** One line of `lbmail tail --json`, or null (a timeout prints nothing). Unknown kinds still count as an event. */
export function tailEvent(data) {
  if (!data || typeof data !== "object") return null;
  return { type: String(data.type ?? "unknown"), account: data.account ?? data.status?.account ?? null };
}

// ---------------------------------------------------------------- what the rows show

/**
 * The per-account rows of `lbmail status`. Today it prints `{accounts, daemon, via, person}`; a
 * daemon before daemon.info printed the rows alone. Anything else is no rows (never a throw).
 */
export function statusAccounts(status) {
  if (Array.isArray(status)) return status;
  if (status && typeof status === "object" && Array.isArray(status.accounts)) return status.accounts;
  return [];
}

/** The daemon's own state from `lbmail status`: paused (no provider calls), its version, where it runs. */
export function daemonState(status) {
  const o = status && typeof status === "object" && !Array.isArray(status) ? status : {};
  return { paused: Boolean(o.daemon?.paused), version: o.daemon?.version ?? null, via: typeof o.via === "string" ? o.via : null };
}

/** Accounts by id with their colour, state and unread count, in the daemon's order. `status` is lbmail status as printed. */
export function accountList(accounts = [], status = [], unreadBy = {}) {
  const st = new Map(statusAccounts(status).map((s) => [s.account, s]));
  return (Array.isArray(accounts) ? accounts : []).map((a, i) => {
    const s = st.get(a.id);
    return {
      id: a.id,
      label: a.label && a.label !== a.id ? a.label : a.id,
      email: a.email,
      persona: typeof a.persona === "string" ? a.persona : Object.values(a.persona ?? {})[0] ?? "other",
      anon: a.persona === "anon",
      color: /^#[0-9a-f]{6}$/i.test(a.color ?? "") ? a.color : ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
      readonly: Boolean(a.readonly),
      ai: a.ai ?? "local_only",
      unread: unreadBy[a.id] ?? null,
      ...accountState(s),
    };
  });
}

/**
 * An account's sync state from `lbmail status`: online, offline (retrying), paused (the sync loop
 * waits for the person: a sign-in error), or unknown (no status yet). The daemon has no other pause.
 */
export function accountState(s) {
  if (!s) return { state: "unknown", note: "no status yet", queued: 0, lastSync: null };
  const queued = s.queued ?? 0;
  const lastSync = s.last_sync ?? null;
  const e = s.error;
  if (e && e.kind === "auth") return { state: "paused", note: `paused: sign-in needed (${e.detail ?? "auth"})`, queued, lastSync };
  if (!s.online) return { state: "offline", note: e ? `offline: ${e.detail ?? e.kind}` : "offline, retrying", queued, lastSync };
  if (e) return { state: "error", note: `${e.kind}: ${e.detail ?? ""}`.trim(), queued, lastSync };
  return { state: "online", note: lastSync ? "online" : "online, first sync", queued, lastSync };
}

/** Unread per category, from `lbmail counts`: {category: unread} and the total. */
export function categoryCounts(counts = []) {
  const by = {};
  let unread = 0;
  let threads = 0;
  for (const c of Array.isArray(counts) ? counts : []) {
    by[c.category] = { unread: c.unread ?? 0, threads: c.threads ?? 0 };
    unread += c.unread ?? 0;
    threads += c.threads ?? 0;
  }
  return { by, unread, threads };
}

/** A thread list row. Sensitive mail keeps only its fixed line (lbmail already sends nothing else). */
export function threadRow(t, accountsById = {}) {
  const tr = t.triage ?? null;
  const sensitive = tr?.category === "sensitive";
  const people = Array.isArray(t.participants) ? t.participants : [];
  const first = people[0];
  const name = (a) => (a?.name && a.name.trim()) || a?.email || "";
  const acct = accountsById[t.account];
  return {
    key: ref(t),
    account: t.account,
    id: t.id,
    color: acct?.color ?? ACCOUNT_COLORS[0],
    readonly: Boolean(acct?.readonly),
    sender: sensitive ? "" : people.length > 1 ? `${name(first)} +${people.length - 1}` : name(first),
    subject: t.subject || "(no subject)",
    summary: sensitive ? "" : (tr?.summary ?? ""),
    snippet: sensitive ? "" : (t.snippet ?? ""),
    category: tr?.category ?? null,
    sensitive,
    suspicious: Boolean(tr?.suspicious),
    needsReply: Boolean(tr?.needs_reply),
    due: tr?.due ?? null,
    unread: (t.unread_count ?? 0) > 0,
    starred: Boolean(t.flagged),
    attachments: Boolean(t.has_attachments),
    count: t.message_count ?? 1,
    date: t.date ?? 0,
    raw: t,
  };
}

/** "14:05" today, "Mon" this week, "3 Nov" this year, else "3 Nov 2025". Times are Unix seconds. */
export function shortTime(seconds, now = Date.now()) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const n = new Date(now);
  const pad = (x) => String(x).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = (now - d.getTime()) / 86400e3;
  if (days >= 0 && days < 6) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  if (d.getFullYear() === n.getFullYear()) return `${d.getDate()} ${months[d.getMonth()]}`;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Mon 9 Nov, 14:05": the reader's date line. */
export function longTime(seconds) {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (x) => String(x).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------- the reader

/**
 * Splits a message's plain text into shown and quoted parts, so quoted history can be folded.
 * `lbmail show` already leaves the quoted history out (render's TextOptions.quoted = false); this
 * catches what is left: runs of `>` lines (2 or more) and everything from an "On ... wrote:" line.
 */
export function splitQuoted(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const parts = [];
  let buf = [];
  let quoted = false;
  const flush = () => {
    if (!buf.length) return;
    const body = buf.join("\n");
    const prev = parts[parts.length - 1];
    if (prev && prev.quoted === quoted) prev.text += `\n${body}`;
    else parts.push({ quoted, text: body });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*On .{3,200}wrote:\s*$/.test(l) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(l.trim())) {
      flush();
      quoted = true;
      buf = lines.slice(i);
      flush();
      break;
    }
    const isQuote = /^\s*>/.test(l);
    if (isQuote !== quoted) {
      // A lone `>` line stays inline: only runs of two or more fold.
      if (isQuote && !/^\s*>/.test(lines[i + 1] ?? "")) { buf.push(l); continue; }
      flush();
      quoted = isQuote;
    }
    buf.push(l);
  }
  flush();
  for (const p of parts) {
    p.text = p.text.replace(/^\n+|\n+$/g, "");
    p.lines = p.text ? p.text.split("\n").length : 0;
  }
  return parts.filter((p) => p.text.length > 0);
}

/**
 * Plain text as Markdown that shows exactly that text: every ASCII punctuation mark escaped (no
 * links, emphasis, headings, HTML or code blocks can come out of mail), leading spaces kept as
 * no-break spaces, and every line break a hard break. Mail is hostile input; TextView only draws it.
 */
export function plainToMarkdown(text) {
  const paras = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split(/\n{2,}/);
  return paras
    .map((p) =>
      p
        .split("\n")
        .map((l) => l.replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`).replace(/^ +/, (s) => " ".repeat(s.length)))
        .join("\\\n"),
    )
    .join("\n\n");
}

/** One message of `lbmail show` as the reader shows it. */
export function messageView(m) {
  return {
    id: m.id,
    from: m.from ?? "",
    date: m.date ?? 0,
    subject: m.subject ?? "",
    sensitive: Boolean(m.sensitive),
    // lbmail prints each attachment as one line ("name (type, N bytes)"); an object is shown by its name.
    attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => (typeof a === "string" ? a : String(a?.name ?? a?.filename ?? "attachment"))),
    suspicious: Boolean(m.suspicious),
    why: (Array.isArray(m.suspicious_why) ? m.suspicious_why : []).map(String),
    replyToDiffers: Boolean(m.reply_to_differs),
    parts: m.sensitive ? [{ quoted: false, text: m.text ?? m.subject ?? "", lines: 1 }] : splitQuoted(m.text),
  };
}

/** `lbmail show` as the reader's messages: a list of messages, or none for anything else. */
export function messageList(data) {
  return (Array.isArray(data) ? data : []).map(messageView);
}

/** The threads of `lbmail ls` / `search` ({threads, next}); a bare list is taken too. */
export function threadList(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.threads) ? data.threads : [];
}

// ---------------------------------------------------------------- the state line

/** What the pane says above everything: the daemon and the accounts in one line, and its colour word. */
export function headline({ failure = null, accounts = [], live = false, at = 0, loaded = true, paused = false } = {}, now = Date.now()) {
  if (failure) return { word: failure.kind === "daemon" ? "stopped" : "error", text: failureText(failure) };
  if (!loaded) return { word: "empty", text: "Reading your mail…" };
  if (!accounts.length) return { word: "empty", text: "No mail accounts yet." };
  const daemonPaused = Boolean(paused);
  paused = accounts.filter((a) => a.state === "paused");
  const offline = accounts.filter((a) => a.state === "offline" || a.state === "error");
  const ro = accounts.filter((a) => a.readonly);
  const bits = [];
  if (daemonPaused) bits.push("daemon paused: no sync (lbmail resume)");
  if (paused.length) bits.push(`${paused.map((a) => a.label).join(", ")} paused (sign-in needed)`);
  if (offline.length) bits.push(`${offline.map((a) => a.label).join(", ")} offline`);
  if (ro.length) bits.push(`${ro.length} read-only`);
  const age = at ? Math.round((now - at) / 1000) : null;
  const fresh = live ? "live" : age === null ? "" : age < 60 ? "just now" : `${Math.round(age / 60)} min ago`;
  return { word: daemonPaused || paused.length || offline.length ? "warn" : "ok", text: [`${accounts.length} account${accounts.length === 1 ? "" : "s"}`, ...bits, fresh].filter(Boolean).join(" · ") };
}

/** Minimum gap between refreshes the daemon's events trigger (poll gently: never under 15 s). */
export const MIN_REFRESH_MS = 15000;
/** Without events (no daemon, or tail not answering): how often to look again. */
export const IDLE_POLL_MS = 60000;
export const DOWN_POLL_MS = 30000;

/** When the next event-driven refresh may run: now if the last was long enough ago, else later. */
export function nextRefreshDelay(lastAt, now = Date.now(), min = MIN_REFRESH_MS) {
  return Math.max(0, lastAt + min - now);
}
