// node tests/restore-logic.test.mjs
import assert from "node:assert";
import { restorable, promptEmpty, resumeCommand, shQuote, trustAnswer } from "../mods/lumbridge-restore/logic.js";

const S = "180ceb84-39bc-47e1-8db3-eac205d4a7e5";
const t = (name, labels = { "claude.session": S }, state = "live") => ({ state, labels, foreground: { name } });
assert(restorable(t("bash")));
assert(restorable(t("zsh")));
assert(!restorable(t("claude")));
assert(!restorable(t("sleep")));
assert(!restorable(t("bash", {})));
assert(!restorable(t("bash", undefined, "finished")));

assert(promptEmpty("old stuff\nsam@desk:~$\n\n"));
assert(promptEmpty("sam@desk:~/Desktop/Workie V2$"));
assert(!promptEmpty("sam@desk:~$ git push"));
assert(!promptEmpty("sam@desk:~$ echo a$"));
assert(!promptEmpty("Compiling foo"));
assert(!promptEmpty(""));
assert(!promptEmpty(null));

assert.equal(resumeCommand({ "claude.session": S }), `claude --resume ${S}`);
assert.equal(
  resumeCommand({ "claude.session": S, "claude.cwd": "/home/sam/Desktop/Workie V2", "claude.flags": "--dangerously-skip-permissions --model x" }),
  `cd '/home/sam/Desktop/Workie V2' && claude --dangerously-skip-permissions --model x --resume ${S}`,
);
assert.equal(resumeCommand({ "claude.session": "x; rm -rf ~" }), null);
assert.equal(resumeCommand({ "claude.session": S, "claude.flags": "--model $(evil)" }), null);
assert.equal(shQuote("it's"), `'it'\\''s'`);

assert.equal(trustAnswer("hello", "/h", "/h"), "none");
assert.equal(trustAnswer("Yes, I trust this folder", "/h", "/h"), "answer");
assert.equal(trustAnswer("Yes, I trust this folder", "/h/x", "/h"), "ask-person");
console.log("ok");
