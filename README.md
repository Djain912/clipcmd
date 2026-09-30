<p align="center">
  <img src="vscode-extension/images/icon.png" width="96" alt="clipcmd">
</p>

<h1 align="center">clipcmd</h1>

<p align="center">
  Copy buttons after every terminal command: the command, its output, or both — in one click.
</p>

<p align="center">
  <a href="https://github.com/Djain912/clipcmd/actions/workflows/ci.yml"><img src="https://github.com/Djain912/clipcmd/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/clipcmd"><img src="https://img.shields.io/npm/v/clipcmd" alt="npm"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=djain912.clipcmd"><img src="https://img.shields.io/visual-studio-marketplace/v/djain912.clipcmd?label=VS%20Code" alt="VS Code Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="MIT"></a>
</p>

<p align="center">
  <a href="docs/clipcmd-launch.mp4"><img src="docs/demo.gif" width="960" alt="clipcmd in 25 seconds: copying a failed build into an AI agent by hand, then one Ctrl+click on [COPY BOTH] and a complete paste"></a>
  <br>
  <a href="docs/clipcmd-launch.mp4"><b>▶ Watch the 25-second video with sound</b></a>
</p>

Every developer has copied a command and its output into an issue, a chat or a doc by dragging the mouse over the terminal. clipcmd puts clickable buttons under every command instead:

- **`[COPY CMD]`** — the command line
- **`[COPY OUTPUT]`** — what it printed, as clean plain text (no colors, progress bars at their final state, wrapped lines joined)
- **`[COPY BOTH]`** — `$ command` and its output, ready to paste
- **`[+]`** — collect several commands and their output into one clipboard entry

Works in **PowerShell** (5.1 and 7), **bash** (including Git Bash), **zsh** and **fish** on **Windows, macOS and Linux** — in Windows Terminal, VS Code, iTerm2, GNOME Terminal, WezTerm, kitty and any other terminal with [clickable links](cli/README.md#terminal-compatibility).

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer (`node -v` tells you which one you have).

1. Install clipcmd:

   ```bash
   npm install -g clipcmd
   ```

2. Set it up for your shell (run this in the shell you use; once per shell):

   ```bash
   clipcmd init
   ```

3. **Open a new terminal** window or tab.
4. Run any command, for example `git status`. The buttons appear under its output.
5. Hold **Ctrl** (**Cmd** on macOS) and click a button. A small **✓ Copied** confirmation appears; paste anywhere.

Using **VS Code**? Also install the [clipcmd extension](https://marketplace.visualstudio.com/items?itemName=djain912.clipcmd) so `[COPY OUTPUT]` and `[COPY BOTH]` work in its terminal.

Something not working? Run `clipcmd doctor`: it checks everything and says how to fix it.

## Learn more

- [How to use it](cli/README.md#using-clipcmd) — the buttons, collecting several commands, where output can be copied
- [Configuration](cli/README.md#configuration) — `~/.config/clipcmd/config.json` and environment variables
- [Troubleshooting](cli/README.md#troubleshooting)
- [Updating and uninstalling](cli/README.md#updating)
- [The VS Code extension](vscode-extension/README.md)

## How it works

A small background program (the daemon) listens on `127.0.0.1`. A hook in your shell's startup file tells it about each command and prints the buttons when the command finishes. The buttons are links: a Ctrl+click opens a tiny handler registered for your user account, which asks the daemon to copy — no browser, no window — and a "✓ Copied" confirmation appears (a tag next to the pointer on Windows). To know what a command printed, interactive terminals run inside a recorder (`clipcmd shell`, automatic); in VS Code, the extension reads the output from VS Code's shell integration instead. Nothing leaves your machine.

Details: [cli/README.md](cli/README.md#how-it-works).

## This repository

| Directory | What | Published as |
|---|---|---|
| [`cli/`](cli) | The `clipcmd` command, background daemon and shell hooks — [full documentation](cli/README.md) | [`clipcmd` on npm](https://www.npmjs.com/package/clipcmd) |
| [`vscode-extension/`](vscode-extension) | Output capture and daemon controls for VS Code's terminal | [`djain912.clipcmd` on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=djain912.clipcmd) |
| [`docs/`](docs) | The launch video and the images in the READMEs | — |

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md). Releases: [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE) © Djain912
