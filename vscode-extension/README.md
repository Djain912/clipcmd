# clipcmd for VS Code

Companion extension for **clipcmd**, the CLI that adds clickable `[COPY CMD] [COPY OUTPUT] [COPY BOTH] [+]` buttons after every command in your terminal.

## Features

**[COPY OUTPUT] and [COPY BOTH] in VS Code's terminal.** A shell hook cannot see what a command printed, but VS Code's shell integration can. The extension reads each command's output (as plain text: colors removed, progress bars at their final state) and hands it to the clipcmd daemon, which attaches it to that command's buttons. Without the extension, VS Code terminals only show `[COPY CMD]` and `[+]`.

**One-click buttons.** On Windows the buttons are `clipcmd://` links. The extension adds `clipcmd` to `terminal.integrated.allowedLinkSchemes` once, so VS Code does not ask before opening them.

**clipcmd: Check Daemon** (Command Palette) tells you whether the clipcmd background daemon is running:

| Situation | Notification |
|---|---|
| Daemon running | ℹ️ `clipcmd daemon is running on port 9666 (PID 1234).` |
| Never started / stopped cleanly | ⚠️ `clipcmd daemon is not running. Start it with clipcmd start.` |
| Crashed or killed (stale port file) | ⚠️ `clipcmd daemon is not running (PID 1234 from its port file has exited). …` |
| Hung / not answering in 2 s | ⚠️ `clipcmd daemon health check timed out on port 9666.` |
| Another program took over the port | ⚠️ `Port 9666 is answering, but not as a clipcmd daemon (HTTP 404). …` |
| Corrupt or unreadable port file | ⚠️ `The clipcmd port file … is invalid. …` |

The command also returns the status object, so other extensions can call
`vscode.commands.executeCommand('clipcmd.checkDaemon')`.

The extension activates after VS Code has finished starting, so it adds nothing to start-up time, and it never shows a notification on its own.

## How it works

It reads the daemon's port file, `~/.config/clipcmd/port` (or `$CLIPCMD_CONFIG_DIR/port`), which contains `port:pid`. Every minute it tells the daemon that a VS Code window can deliver output (`GET /client?kind=vscode`); when a terminal command finishes it sends the output with `POST /output`. Everything stays on `127.0.0.1`.

The copy buttons themselves come from the clipcmd shell hook (PowerShell, bash, zsh or fish) and work alongside VS Code's own shell integration; see the clipcmd README for setup (`clipcmd init`, `clipcmd start`). Requires VS Code 1.93 or newer (terminal shell integration API).

## Development

```bash
npm install
npm run compile
```

Press **F5** (*Run Extension*) to open an Extension Development Host with the extension loaded, then run **clipcmd: Check Daemon** from the Command Palette.

### Tests

```bash
npm run test:unit          # daemon client and output capture, against real local HTTP servers
npm run test:integration   # launches VS Code and runs the tests inside it (incl. a real terminal)
npm test                   # both
```

- `test:integration` downloads the latest stable VS Code into `.vscode-test/` unless `VSCODE_EXECUTABLE_PATH` points at an installed one (or `VSCODE_TEST_VERSION` picks a version, 1.101 or newer).
- Set `CLIPCMD_DAEMON_ENTRY` to the clipcmd CLI's `dist/daemon/index.js` to also run the unit tests against the real daemon.
- Tests use a temporary `CLIPCMD_CONFIG_DIR`, so a daemon you are running is never touched.

### Package and install

```bash
npm run package                              # builds clipcmd-vscode-0.0.1.vsix
code --install-extension clipcmd-vscode-0.0.1.vsix
```
