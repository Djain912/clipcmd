# Changelog

## 0.0.1 — 2026-09-30

First public release.

- `[COPY OUTPUT]` and `[COPY BOTH]` work in VS Code's terminal: each command's output is read from VS Code's shell integration, cleaned to plain text (colors removed, progress bars at their final state) and handed to the clipcmd daemon.
- `clipcmd://` button links open without a confirmation prompt.
- **clipcmd: Check Daemon** reports the daemon's state and offers **Start Daemon** when that would fix it.
- **clipcmd: Start Daemon** runs `clipcmd start`, or explains how to install the CLI when it is missing.
- `clipcmd.cliPath` setting (machine-scoped) for a `clipcmd` that is not on `PATH`.
