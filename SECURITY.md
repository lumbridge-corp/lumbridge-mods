# Security policy

## Reporting a problem

Please do not open a public issue, pull request or discussion for a security problem.

Email **security@lumbridgecorp.com**, or use "Report a vulnerability" on this repo's Security tab.

Please include the commit (`git rev-parse HEAD`), the `lumbridge-app --version`, your operating system, what you did,
what happened, what you expected, and a small way to reproduce it if you have one. Remove passwords, tokens, mail and
private data from logs before you send them.

## What happens next

- We reply to say we have your report.
- We tell you whether we can reproduce it and what we plan to do.
- We keep you informed until it is fixed or closed.
- We credit you in the change log when the fix ships, unless you ask us not to.

Please give us a fair chance to fix the problem before you publish it. We ask for 90 days, or less if a fix is out
sooner.

## Supported versions

The latest commit on `main` is supported. There are no back-ports.

## How these mods are meant to be used

- Mods are trusted JavaScript, not sandboxed extensions. They run as you, inside the Lumbridge window, and can run
  programs, read files and type into terminals, here and on connected machines. Read a mod before you install it.
- `lumbridge-restore` types a `claude --resume` command into a pane, only after you confirm, and only when the pane's
  last line is an empty prompt.
- `lumbridge-favorites` moves running terminals between tabs; it does not start or stop programs.
- `lumbridge-mail` uses `lbmail` in agent mode: sensitive mail is shown only as a fixed line, and sending is not
  possible from it. Mail text is drawn as plain text, never as links or markup.

## What counts

In scope: mail, terminal output or a file name that makes a mod run a command, type into a terminal or open a
connection it should not; a mod acting without the confirm it shows; leaks of tokens or mail to logs or the network;
a secret or private data committed to this repository.

Out of scope: anything that needs an attacker who already has your user account; mods you wrote or installed from
elsewhere; problems in the app, the core or the mail daemon themselves (report those in their repositories).

## Good faith

We will not take legal action against anyone who finds and reports a problem in good faith, keeps to this policy,
and does not access or change other people's data.
