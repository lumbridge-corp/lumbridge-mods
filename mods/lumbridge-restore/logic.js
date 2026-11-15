// Pure rules of lumbridge-restore, tested by logic.test.mjs (no lumbridge imports here).

const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "nu"]);

/** The core's terminal record says: a Claude was here, and now only its shell is. */
export function restorable(t) {
  if (t?.state !== "live" || !t.labels?.["claude.session"]) return false;
  const name = t.foreground?.name ?? (t.argv?.[0] ?? "").split("/").pop();
  return SHELLS.has(name);
}

/** Whether a terminal's screen ends at an empty shell prompt. Unsure means no: this decides
 *  whether we may type there, so typed text, a running program or an odd prompt all refuse. */
export function promptEmpty(screen) {
  const lines = String(screen ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l);
  const last = lines[lines.length - 1];
  if (!last || !/[$#%>❯]$/.test(last)) return false;
  return !/[$#%>❯] /.test(last); // "user@box:~$ echo a$" has a prompt with words after it
}

/** A word safe to paste into a POSIX shell. */
export function shQuote(s) {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `'${String(s).replaceAll("'", `'\\''`)}'`;
}

/** The line typed in the pane, or null if the labels don't look like ours. Flags came from the
 *  hook's allow-list, but labels are free-form, so they're checked again here. */
export function resumeCommand(labels) {
  const session = labels?.["claude.session"] ?? "";
  if (!/^[0-9a-fA-F-]{36}$/.test(session)) return null;
  const flags = (labels["claude.flags"] ?? "").split(" ").filter(Boolean);
  if (!flags.every((f) => /^[A-Za-z0-9_.,:=\/-]+$/.test(f))) return null;
  const claude = ["claude", ...flags, "--resume", session].join(" ");
  const cwd = labels["claude.cwd"];
  return cwd ? `cd ${shQuote(cwd)} && ${claude}` : claude;
}

/** Claude asks about the folder on start; only home is answered for us, since Claude never
 *  saves trust for home and it would ask on every restore. Anything else stays the person's. */
export function trustAnswer(screen, cwd, home) {
  if (!String(screen ?? "").includes("Yes, I trust this folder")) return "none";
  return cwd === home ? "answer" : "ask-person";
}
