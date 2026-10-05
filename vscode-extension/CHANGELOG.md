# Changelog

## 0.0.3 — 2026-10-05

- The extension points out the missing half: when VS Code starts without the clipcmd npm package, a notification offers to install it (`npm install -g clipcmd` and `clipcmd init` in a new terminal); when the package is installed but not set up for a shell, it offers to run `clipcmd init`. "Don't Show Again" turns it off.
- "How to Install" opens the install steps on the website, and the Marketplace page links to it.

## 0.0.2 — 2026-10-02

- README: an animated demo and a 25-second video at the top, and a clear note that clipcmd comes in two parts: install the clipcmd npm package and this extension. No code changes.

## 0.0.1 — 2026-09-30

First public release.

- `[COPY OUTPUT]` and `[COPY BOTH]` work in VS Code's terminal: each command's output is read from VS Code's shell integration, cleaned to plain text (colors removed, progress bars at their final state) and handed to the clipcmd daemon.
- `clipcmd://` button links open without a confirmation prompt.
- **clipcmd: Check Daemon** reports the daemon's state and offers **Start Daemon** when that would fix it.
- **clipcmd: Start Daemon** runs `clipcmd start`, or explains how to install the CLI when it is missing.
- `clipcmd.cliPath` setting (machine-scoped) for a `clipcmd` that is not on `PATH`.
