# Changelog

All notable changes to the `clipcmd` CLI. This project follows [Semantic Versioning](https://semver.org/).

## 0.0.1 — 2026-09-30

First public release.

- Four buttons after every command: `[COPY CMD]`, `[COPY OUTPUT]`, `[COPY BOTH]` and `[+]` (collect several commands).
- Hooks for PowerShell (Windows PowerShell 5.1 and PowerShell 7), bash (including Git Bash and bash-preexec), zsh and fish. They keep your prompt, `$?`, exit codes and other shell integrations (VS Code, oh-my-posh, starship) working.
- Output capture everywhere: interactive terminal sessions continue inside `clipcmd shell`, which records exactly what each command displayed; the VS Code extension captures output in VS Code's terminal.
- Silent copying: `clipcmd init` registers a `clipcmd://` link handler for your user account on Windows, Linux and macOS, and allows it in Windows Terminal, so a click copies without opening a browser or asking for confirmation.
- On Windows (except in VS Code), buttons are `file:///` links to small shortcuts that run the link handler, because Windows Terminal (a Store app) cannot open link handlers registered for a single user, and cannot always be recognized. `clipcmd doctor` checks the shortcut template they need.
- The first few sessions print a one-line tip under the buttons: hold Ctrl (Cmd on macOS) and click a button to copy.
- Each click is confirmed: a small "✓ Copied command" tag next to the mouse pointer on Windows (built once with the C# compiler that ships with Windows; it never takes focus and shows even with Do Not Disturb on), a notification on macOS and Linux. `"copyFeedback": false` turns it off.
- The daemon starts by itself with your first terminal (also after a reboot or a crash); `clipcmd stop` keeps it off until `clipcmd start`.
- `clipcmd doctor` checks the setup and explains how to fix problems.
- `clipcmd uninstall --all` removes everything clipcmd added.
- The daemon only listens on 127.0.0.1 and rejects cross-site browser requests and DNS rebinding.
- `clipcmd init` keeps the encoding of your shell config files (UTF-8, UTF-8 with BOM, UTF-16, legacy code pages) byte-for-byte outside the clipcmd block.
