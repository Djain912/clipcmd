# clipcmd

Copy buttons after every terminal command: the command, its output, or both, in one click.

[![npm version](https://img.shields.io/npm/v/clipcmd)](https://www.npmjs.com/package/clipcmd)
[![CI](https://github.com/Djain912/clipcmd/actions/workflows/ci.yml/badge.svg)](https://github.com/Djain912/clipcmd/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

```
PS C:\project> npm test
  ✓ 42 tests passed
[COPY CMD] [COPY OUTPUT] [COPY BOTH] [+]
```

| Button          | Copies |
|-----------------|--------|
| `[COPY CMD]`    | the command line |
| `[COPY OUTPUT]` | what the command printed, as plain text |
| `[COPY BOTH]`   | `$ command` followed by its output — ready to paste into an issue or a chat |
| `[+]`           | adds the command (with its output) to a collection and copies the whole collection; click `[+]` on several commands to gather them, click again to remove one |

Works in PowerShell (Windows PowerShell 5.1 and PowerShell 7), bash (including Git Bash), zsh and fish, on Windows, macOS and Linux.

---

## Install

```bash
npm install -g clipcmd
clipcmd init        # run it in the shell you use
```

Then open a new terminal. That's it: the background daemon starts by itself with your first terminal (also after a reboot), and clicking a button copies silently — no browser tab, no window.

`clipcmd init` detects your shell (from `$SHELL`, or on Windows the PowerShell you run it from); pass `bash`, `zsh`, `fish`, `powershell` or `pwsh` to choose. Run it once per shell you use. Something not working? Run `clipcmd doctor`.

The [clipcmd VS Code extension](https://marketplace.visualstudio.com/items?itemName=djain912.clipcmd) adds output capture in VS Code's terminal.

Requires Node.js 20 or newer.

---

## How It Works

`clipcmd` runs a small background **daemon** on `127.0.0.1`. A **hook** in your shell config tells it about every command and prints the buttons when the command finishes. The buttons are [OSC 8 hyperlinks](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda); `clipcmd init` registers a `clipcmd://` link handler for your user account, so a click just tells the daemon what to copy:

- **Windows**: under `HKCU\Software\Classes\clipcmd` (no admin rights); a click runs a tiny script with `wscript.exe`, which shows no window. `clipcmd init` also adds `"clipcmd"` to Windows Terminal's `safeUriSchemes` so it does not ask before each click (the original `settings.json` is backed up to `~/.config/clipcmd/backups/`).
- **Linux**: a hidden `.desktop` entry set as the default `x-scheme-handler/clipcmd` with `xdg-mime`.
- **macOS**: a tiny background app in `~/Applications` that declares the URL scheme.

Without a handler (or with `"links": "http"`), the buttons are `http://127.0.0.1` links that your browser opens; the tab says what was copied and closes itself.

### Output capture

A shell hook knows which command ran, but not what it printed. So in a regular terminal, interactive shells continue inside `clipcmd shell`, which records the session: it runs the shell in a pseudo-terminal ([`node-pty`](https://github.com/microsoft/node-pty)) and mirrors it into a headless terminal emulator (the one VS Code uses). The hook marks where each command's output starts and ends, so what gets copied is exactly what the command displayed: colors and cursor movement are resolved, progress bars keep their final state, and long lines that wrapped are joined back into one.

This is skipped:

- in **VS Code**, where the clipcmd VS Code extension reads each command's output from VS Code's shell integration instead;
- over **SSH**, in Emacs, in terminals node-pty cannot relay (Git Bash's own mintty window), and when the shell was started to run something (`powershell -Command ...`, "Developer PowerShell" shortcuts, scripts);
- when you turn it off with `"autoShell": false` in the config or `CLIPCMD_AUTOSHELL=0`.

If the wrapper cannot start (for example `node-pty` is missing), the session simply continues without output capture. Where no output is captured, only `[COPY CMD]` and `[+]` are shown, and the terminal says once how to enable the others.

Starting a terminal runs your shell's startup files twice (once before the hook moves into the wrapper), which adds a little start-up time.

---

## Commands

| Command                     | Description |
|-----------------------------|-------------|
| `clipcmd init [shell]`      | Installs the hook into your shell config and registers the `clipcmd://` link handler. Re-running refreshes an existing hook (do this after upgrading clipcmd). |
| `clipcmd doctor`            | Checks the whole setup and says how to fix what is missing. |
| `clipcmd status`            | Shows whether the daemon is running, its port and process ID. |
| `clipcmd start`             | Starts the daemon now (shells also start it automatically). |
| `clipcmd stop`              | Stops the daemon. It stays off — new shells do not start it — until you run `clipcmd start`. |
| `clipcmd shell [shell]`     | Runs a shell with output capture (what the hooks do automatically). |
| `clipcmd uninstall [shell]` | Removes the hook from one shell's config (and the link handler, once no shell uses clipcmd). |
| `clipcmd uninstall --all`   | Removes clipcmd from every shell, removes the link handler and stops the daemon. Run it before `npm uninstall -g clipcmd`. |
| `clipcmd open <url>`        | Handles a `clipcmd://` link (what the Linux and macOS link handlers run). |
| `clipcmd --version`         | Prints the installed version. |

Commands exit with code 1 when they fail; `doctor` exits with 1 when it finds a problem; `shell` exits with 126 when it cannot start, otherwise with the shell's exit code.

---

## Collecting Several Commands (`[+]`)

Click `[+]` after each command you want. Every click puts the whole collection on the clipboard right away, oldest command first:

```
$ command one
output of command one

$ command two
output of command two

```

Clicking `[+]` on a collected command removes it (and re-copies the rest). To copy the collection and start a new one, visit `/copy-selected` on the daemon (port from `clipcmd status`), e.g. `http://127.0.0.1:9666/copy-selected`.

---

## Terminal Compatibility

The buttons need a terminal that supports OSC 8 hyperlinks; elsewhere they appear as plain text.

| Terminal                   | Clickable buttons |
|----------------------------|-------------------|
| Windows Terminal           | ✅ (1.24+ copies without asking; `clipcmd init` allows `clipcmd://` in its settings) |
| VS Code terminal           | ✅ (works alongside VS Code's shell integration) |
| iTerm2, WezTerm, kitty     | ✅ |
| GNOME Terminal, Konsole, other VTE-based terminals | ✅ |
| Alacritty (0.11+)          | ✅ |
| tmux                       | ⚠️ needs `set -ga terminal-features "*:hyperlinks"` |
| macOS Terminal.app         | ❌ no OSC 8 support |
| Windows console host (conhost) | ❌ no OSC 8 support — use Windows Terminal |

**PowerShell**: the hook works in any interactive console with PSReadLine (the default), including VS Code's terminal alongside VS Code's PowerShell integration. It keeps your prompt (oh-my-posh, starship, posh-git, ...), `$?` and `$LASTEXITCODE` intact. Exit codes are `0`/`1` for PowerShell commands and the real exit code for native programs. Windows PowerShell 5.1 and PowerShell 7 have separate profiles: run `clipcmd init` from each one you use.

`clipcmd init` refuses to edit your profile while PowerShell's execution policy is `Restricted` or `AllSigned`, because PowerShell would then refuse to run the profile and print an error in every new window. It tells you how to allow local scripts for your account (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`); it never changes the policy itself.

**bash**: terminals that start *login* shells (macOS Terminal, Git Bash) read `~/.bash_profile` instead of `~/.bashrc`; `clipcmd init` warns when your `~/.bash_profile` does not load `~/.bashrc`. Works with [bash-preexec](https://github.com/rcaloras/bash-preexec) and VS Code's shell integration.

**cmd.exe** is not supported: it has no way to run code before and after each command.

---

## Troubleshooting

Start with `clipcmd doctor`: it checks Node.js, the config, the daemon, each hook (and whether it is from the installed version), PowerShell's execution policy, `node-pty`, the link handler, Windows Terminal's settings and the VS Code extension.

**Clicking a button opens a browser tab** — no `clipcmd://` handler is registered (run `clipcmd init`), or `"links": "http"` is set in the config. Existing buttons keep their old links; new commands get new ones.

**Windows Terminal asks "open this link?" on every click** — your Windows Terminal is older than 1.24, or `clipcmd init` could not edit its settings (it says so). Add `"safeUriSchemes": ["clipcmd"]` to the top level of Windows Terminal's `settings.json`.

**VS Code asks whether to allow `clipcmd` links** — choose *Allow* once, or install the clipcmd VS Code extension, which allows them for you.

**Only `[COPY CMD]` and `[+]` are shown** — this terminal has no output capture; see [Output capture](#output-capture) for when it is skipped. In VS Code, install the clipcmd VS Code extension.

**No buttons at all** — open a new terminal after `clipcmd init`. If you ran `clipcmd stop`, run `clipcmd start`. `~/.config/clipcmd/daemon.log` says why a daemon failed to start.

**No buttons after a command in parentheses (bash)** — a command that is only a subshell, such as `(cd /tmp && make)`, does not trigger the hook (bash runs no `DEBUG` trap for it). `cd /tmp && make` works.

**Is the terminal slower when the daemon is not running?** — no: the hooks give up after 0.5–1 s, start the daemon in the background, and skip it for 30 seconds (10 commands in fish) if it still does not answer.

---

## Configuration

`~/.config/clipcmd/config.json` (optional):

```json
{
  "port": 9666,
  "ringBufferSize": 200,
  "maxOutputBytes": 1048576,
  "links": "auto",
  "autoShell": true
}
```

| Key              | Default   | Description |
|------------------|-----------|-------------|
| `port`           | `9666`    | Preferred port for the daemon. Falls back to the next free port (up to +10). |
| `ringBufferSize` | `200`     | Number of commands kept in memory (1–10000). |
| `maxOutputBytes` | `1048576` | Output kept per command; longer output keeps its last bytes (0 disables capture). |
| `links`          | `"auto"`  | `"clipcmd"`: silent `clipcmd://` links; `"http"`: browser links; `"auto"`: `clipcmd://` when the handler is registered. |
| `autoShell`      | `true`    | Run interactive terminal sessions inside `clipcmd shell` for output capture. |

Missing, corrupt or invalid values fall back to the defaults (with a warning in the log). `links` applies to each new command, `autoShell` to each new terminal, the others when the daemon starts (`clipcmd stop` then `clipcmd start`).

The daemon writes its port to `~/.config/clipcmd/port` (as `port:pid`) and logs to `~/.config/clipcmd/daemon.log` (rotated at 1 MB).

Environment variables:

| Variable | Effect |
|----------|--------|
| `CLIPCMD_CONFIG_DIR` | Use another directory instead of `~/.config/clipcmd` (honored by the daemon, CLI, hooks and VS Code extension). |
| `CLIPCMD_AUTOSHELL` | `0` turns automatic `clipcmd shell` off; `1` forces it (outside VS Code). |
| `CLIPCMD_AUTOSTART` | `0` stops the hooks from starting the daemon. |
| `CLIPCMD_POWERSHELL_PROFILE` | Makes `clipcmd init` / `uninstall` use this PowerShell profile file. |

`clipcmd init` edits shell config files in place and keeps their encoding (UTF-8, UTF-8 with BOM, UTF-16 as written by Windows PowerShell's `>`, or legacy code pages) byte-for-byte outside the clipcmd block.

---

## Security

The daemon only listens on `127.0.0.1`, never on your network. Because any web page can make your browser send requests to `127.0.0.1`, the daemon rejects requests that carry browser cross-site markers (`Origin`, or `Sec-Fetch-Site` other than `none`) or an unexpected `Host` header (DNS rebinding). Clicking a copy button — a top-level navigation you started — is still allowed.

The `clipcmd://` handler only forwards the copy and `[+]` actions, with a plain query string, to the daemon registered in `~/.config/clipcmd/port`. A copy only happens for a command id that exists in the daemon's history. Commands and their output are kept only in the daemon's memory (the last `ringBufferSize` commands): nothing is written to disk or sent anywhere.

See [SECURITY.md](https://github.com/Djain912/clipcmd/blob/main/SECURITY.md) to report a vulnerability.

---

## Development

```bash
npm install
npm test          # builds dist/, then runs unit, property and end-to-end tests
```

The end-to-end tests run the real CLI, real bash (Git Bash on Windows), zsh and fish when installed, a real interactive PowerShell through a pseudo-console (Windows PowerShell 5.1, and PowerShell 7 when `pwsh` is installed or `CLIPCMD_TEST_PWSH` points at it), VS Code's real bash and PowerShell shell-integration scripts when VS Code is installed, a real PTY via `node-pty`, and the `clipcmd://` handler registered under a throwaway scheme name and opened the way terminals open links. Tests never touch your real `~/.config/clipcmd`, shell config files, Windows Terminal settings, link handler registration, or clipboard, and never start daemons from the hooks (`test/e2e/isolation.test.ts` guards this).

---

## License

[MIT](LICENSE) © Djain912
