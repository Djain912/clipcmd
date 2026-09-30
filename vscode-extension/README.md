# clipcmd for VS Code

Copy a terminal command's **output** — or the command and its output together — with one click, right in VS Code's terminal.

```
PS C:\project> npm test
  ✓ 42 tests passed
[COPY CMD] [COPY OUTPUT] [COPY BOTH] [+]
```

This extension is the VS Code half of [**clipcmd**](https://www.npmjs.com/package/clipcmd), the CLI that prints these buttons after every command in PowerShell, bash, zsh and fish.

## Getting started

1. Install the clipcmd CLI (Node.js 20+) and set up your shell — in VS Code's terminal:

   ```bash
   npm install -g clipcmd
   clipcmd init
   ```

2. Install this extension, then open a new terminal.

Run any command and click a button. The clipcmd daemon starts by itself with your first terminal; **clipcmd: Check Daemon** tells you if something is off and offers to start it.

## What the extension does

**Makes [COPY OUTPUT] and [COPY BOTH] work in VS Code's terminal.** A shell hook cannot see what a command printed, but VS Code's shell integration can. The extension reads each command's output — as plain text: colors removed, progress bars at their final state — and hands it to the clipcmd daemon, which attaches it to that command's buttons. Without the extension, VS Code terminals only show `[COPY CMD]` and `[+]`.

**Makes clicks silent.** The buttons are `clipcmd://` links. The extension adds `clipcmd` to `terminal.integrated.allowedLinkSchemes` once, so VS Code does not ask before opening them.

**Commands** (Command Palette):

- **clipcmd: Check Daemon** — shows whether the clipcmd background daemon is running. When it is not, the notification offers **Start Daemon**.
- **clipcmd: Start Daemon** — runs `clipcmd start`. If the CLI is not installed, it tells you how to install it.

| Situation | Notification |
|---|---|
| Daemon running | ℹ️ `clipcmd daemon is running on port 9666 (PID 1234).` |
| Not started, or stopped with `clipcmd stop` | ⚠️ `clipcmd daemon is not running. …` **[Start Daemon]** |
| Crashed (stale port file) | ⚠️ `clipcmd daemon is not running (PID 1234 from its port file has exited). …` **[Start Daemon]** |
| Hung / not answering within 2 s | ⚠️ `clipcmd daemon health check timed out on port 9666.` |
| Another program took over the port | ⚠️ `Port 9666 is answering, but not as a clipcmd daemon (HTTP 404). …` |

Both commands also return their result, so other extensions can call `vscode.commands.executeCommand('clipcmd.checkDaemon')`.

The extension activates after VS Code has finished starting, so it adds nothing to start-up time, and it never shows a notification on its own.

## Settings

| Setting | Default | Description |
|---|---|---|
| `clipcmd.cliPath` | `""` | Path to the `clipcmd` executable used by **Start Daemon**; empty uses `clipcmd` from `PATH`. Machine-scoped: a workspace cannot change it. |

## Privacy

Everything stays on your machine. The extension talks only to the clipcmd daemon on `127.0.0.1`: every minute it says a VS Code window can deliver output (`GET /client?kind=vscode`), and when a terminal command finishes it sends that command's output (`POST /output`). The daemon keeps commands in memory only. No telemetry.

## Requirements

- VS Code 1.93 or newer (terminal shell integration API), with shell integration enabled (the default).
- The [clipcmd CLI](https://www.npmjs.com/package/clipcmd), set up with `clipcmd init`.

## Development

```bash
npm install
npm run compile
```

Press **F5** (*Run Extension*) to open an Extension Development Host with the extension loaded.

```bash
npm run test:unit          # CLI runner, daemon client and output capture, against real local HTTP servers
npm run test:integration   # launches VS Code and runs the tests inside it (incl. a real terminal)
npm test                   # both
npm run package            # builds clipcmd-<version>.vsix
```

- `test:integration` downloads the latest stable VS Code into `.vscode-test/` unless `VSCODE_EXECUTABLE_PATH` points at an installed one (or `VSCODE_TEST_VERSION` picks a version, 1.101 or newer). It uses its own user-data directory, so your VS Code settings are never touched.
- Set `CLIPCMD_DAEMON_ENTRY` to the clipcmd CLI's `dist/daemon/index.js` to also run the unit tests against the real daemon.
- Tests use a temporary `CLIPCMD_CONFIG_DIR`, so a daemon you are running is never touched.

## License

[MIT](LICENSE) © Djain912
