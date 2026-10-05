# clipcmd for VS Code

Copy a terminal command's **output** — or the command and its output together — with one click, right in VS Code's terminal.

![clipcmd in 25 seconds: copying a failed build into an AI agent by hand, then one Ctrl+click on [COPY BOTH] and a complete paste](https://raw.githubusercontent.com/Djain912/clipcmd/main/docs/demo.gif)

[**▶ Download the 25-second video with sound (MP4, 6.5 MB)**](https://github.com/Djain912/clipcmd/raw/main/docs/clipcmd-launch.mp4)

[![Step 1: install the clipcmd npm package](https://img.shields.io/badge/Step%201-Install%20the%20npm%20package-CB3837?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/clipcmd)
[![Step 2: install the clipcmd VS Code extension](https://img.shields.io/badge/Step%202-Install%20the%20VS%20Code%20extension-007ACC?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0yMC41IDExSDE5VjdjMC0xLjEtLjktMi0yLTJoLTRWMy41QzEzIDIuMTIgMTEuODggMSAxMC41IDFTOCAyLjEyIDggMy41VjVINGMtMS4xIDAtMS45OS45LTEuOTkgMnYzLjhIMy41YzEuNDkgMCAyLjcgMS4yMSAyLjcgMi43cy0xLjIxIDIuNy0yLjcgMi43SDJWMjBjMCAxLjEuOSAyIDIgMmgzLjh2LTEuNWMwLTEuNDkgMS4yMS0yLjcgMi43LTIuNyAxLjQ5IDAgMi43IDEuMjEgMi43IDIuN1YyMkgxN2MxLjEgMCAyLS45IDItMnYtNGgxLjVjMS4zOCAwIDIuNS0xLjEyIDIuNS0yLjVTMjEuODggMTEgMjAuNSAxMXoiLz48L3N2Zz4%3D)](#getting-started)

> ### ⚠️ clipcmd comes in two parts — install both
>
> 1. **The [`clipcmd` package from npm](https://www.npmjs.com/package/clipcmd)** — the command, the background daemon and the shell hooks. It puts the buttons under every command, in every terminal: `npm install -g clipcmd`, then `clipcmd init`. **This extension does nothing without it.**
> 2. **This extension** — makes `[COPY OUTPUT]` and `[COPY BOTH]` work in VS Code's terminal (without it, VS Code only shows `[COPY CMD]` and `[+]`).

This extension is the VS Code half of [**clipcmd**](https://www.npmjs.com/package/clipcmd), the command-line tool that prints these buttons after every command in PowerShell, bash, zsh and fish.

## Getting started

| Part | What it does | Install |
|---|---|---|
| **npm package** `clipcmd` | The buttons, in every terminal | `npm install -g clipcmd`, then `clipcmd init` |
| **VS Code extension** `djain912.clipcmd` (this one) | `[COPY OUTPUT]` and `[COPY BOTH]` in VS Code's terminal | the **Install** button on this page, or `code --install-extension djain912.clipcmd` |

1. Install [Node.js](https://nodejs.org) 20 or newer, if you do not have it (`node -v` tells you).
2. **Install the npm package.** In a terminal (VS Code's is fine):

   ```bash
   npm install -g clipcmd
   ```

3. **Set it up** for the shell you use in VS Code:

   ```bash
   clipcmd init
   ```

4. **Install this extension** — the **Install** button on this page, or search **clipcmd** in VS Code's Extensions view (**Ctrl+Shift+X**, **Cmd+Shift+X** on macOS).
5. Open a **new** terminal (**Terminal → New Terminal**).
6. Run any command, then hold **Ctrl** (**Cmd** on macOS) and click a button under it. A small **✓ Copied** confirmation appears; paste anywhere.

The clipcmd daemon starts by itself with your first terminal. **clipcmd: Check Daemon** (Command Palette) tells you if something is off and offers to start it; `clipcmd doctor` in a terminal checks the whole setup.

## What the extension does

**Makes [COPY OUTPUT] and [COPY BOTH] work in VS Code's terminal.** A shell hook cannot see what a command printed, but VS Code's shell integration can. The extension reads each command's output — as plain text: colors removed, progress bars at their final state — and hands it to the clipcmd daemon, which attaches it to that command's buttons. Without the extension, VS Code terminals only show `[COPY CMD]` and `[+]` (unless you run `clipcmd shell` in the terminal yourself).

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

**Tells you when the other half is missing.** When VS Code starts, the extension checks for the clipcmd npm package. If it is not installed, a notification offers **Install** (runs `npm install -g clipcmd` and `clipcmd init` in a new terminal); if it is installed but not set up for your shell, it offers **Set Up** (runs `clipcmd init`). **Don't Show Again** turns the notice off. Otherwise the extension shows nothing on its own.

The extension activates after VS Code has finished starting, so it adds nothing to start-up time.

## Settings

| Setting | Default | Description |
|---|---|---|
| `clipcmd.cliPath` | `""` | Path to the `clipcmd` executable used by **Start Daemon**; empty uses `clipcmd` from `PATH`. Machine-scoped: a workspace cannot change it. |

clipcmd's own settings — the port, how many commands it remembers, the ✓ Copied confirmation, and more — live in `~/.config/clipcmd/config.json`; see [Configuration](https://github.com/Djain912/clipcmd/blob/main/cli/README.md#configuration).

## Troubleshooting

- **No buttons** — open a new terminal after `clipcmd init`, and check that the daemon runs (**clipcmd: Check Daemon**). `clipcmd doctor` finds the rest.
- **Clicking does nothing** — hold Ctrl (Cmd on macOS) while you click.
- **Only `[COPY CMD]` and `[+]`** — the extension is not active in this window (run **Developer: Reload Window** after installing it), or VS Code's shell integration is off: `terminal.integrated.shellIntegration.enabled` must be `true` (the default).
- **VS Code asks whether to open `clipcmd` links** — choose *Allow*, or reload the window so the extension can allow them.

More in the CLI's [troubleshooting guide](https://github.com/Djain912/clipcmd/blob/main/cli/README.md#troubleshooting).

## Privacy

Everything stays on your machine. The extension talks only to the clipcmd daemon on `127.0.0.1`: every minute it says a VS Code window can deliver output (`GET /client?kind=vscode`), and when a terminal command finishes it sends that command's output (`POST /output`). The daemon keeps commands in memory only. No telemetry.

## Requirements

- VS Code 1.93 or newer (terminal shell integration API), with shell integration enabled (the default).
- The [clipcmd CLI](https://www.npmjs.com/package/clipcmd), set up with `clipcmd init`.

## Contributing

Source, issues and development setup: [github.com/Djain912/clipcmd](https://github.com/Djain912/clipcmd) — see [CONTRIBUTING.md](https://github.com/Djain912/clipcmd/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/Djain912/clipcmd/blob/main/LICENSE) © Djain912
