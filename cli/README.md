# clipcmd

Inject clickable OSC 8 copy buttons into your terminal after every command

[![npm version](https://img.shields.io/npm/v/clipcmd)](https://www.npmjs.com/package/clipcmd)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

---

## How It Works

`clipcmd` runs a lightweight background **daemon** that communicates with **shell hooks** injected into your shell config (PowerShell, bash, zsh, fish). After every command, the hook prints four clickable buttons:

```
[COPY CMD] [COPY OUTPUT] [COPY BOTH] [+]
```

| Button          | Copies |
|-----------------|--------|
| `[COPY CMD]`    | the command line |
| `[COPY OUTPUT]` | what the command printed, as plain text |
| `[COPY BOTH]`   | `$ command` followed by its output |
| `[+]`           | adds the command (with its output) to a collection and copies the whole collection; click `[+]` on several commands to gather them, click again to remove one |

The buttons are OSC 8 hyperlinks. On Windows, `clipcmd init` registers a small `clipcmd://` link handler, so a click copies silently — no browser, no window. Elsewhere the buttons are `http://127.0.0.1` links that your browser opens; the tab says what was copied and closes itself.

**Output** is captured automatically in PowerShell (it runs inside `clipcmd shell`) and in VS Code's terminal (with the clipcmd VS Code extension); anywhere else, run `clipcmd shell`. Where no output can be captured, only `[COPY CMD]` and `[+]` are shown, and the terminal says once how to enable the others. See [Output Capture](#output-capture).

---

## Installation

```bash
npm install -g clipcmd
# or use npx without installing:
npx clipcmd init
```

From a source checkout:

```bash
npm install
npm run build
npm install -g .      # puts `clipcmd` on your PATH
```

---

## Quick Start

```bash
clipcmd init    # installs the shell hook (and, on Windows, the silent link handler)
clipcmd start   # starts the background daemon
# Now open a new terminal
```

Opening a new terminal is the safest choice: some shell integrations (e.g. VS Code's) are set up once when the terminal starts. You can also reload your shell config in place:

```bash
source ~/.zshrc                      # zsh
source ~/.bashrc                     # bash
source ~/.config/fish/config.fish    # fish
```

```powershell
. $PROFILE                           # PowerShell
```

---

## Commands Reference

| Command                     | Description                                                                 |
|-----------------------------|-----------------------------------------------------------------------------|
| `clipcmd init [shell]`      | Injects the hook into your shell config. Detects your shell (from `$SHELL`, or on Windows the PowerShell you run it from), or pass `zsh`, `bash`, `fish`, `powershell` (Windows PowerShell 5.1) or `pwsh` (PowerShell 7+). Re-running refreshes an existing hook. On Windows it also registers the `clipcmd://` link handler. |
| `clipcmd start`             | Starts the background daemon (detached, persists after terminal closes) and waits until it answers. |
| `clipcmd stop`              | Asks the daemon to shut down and waits for it to exit.                      |
| `clipcmd status`            | Shows whether the daemon is running, its port, and its process ID.          |
| `clipcmd uninstall [shell]` | Removes the hook block from your shell config file (and the link handler, once no shell uses clipcmd). |
| `clipcmd shell [shell]`     | Runs a shell inside clipcmd's terminal wrapper so its command output can be copied. |
| `clipcmd --version`         | Prints the installed version.                                               |

`start`, `stop`, `init` and `uninstall` exit with code 1 when they fail; `shell` exits with 126 when it cannot start, otherwise with the shell's exit code.

---

## Output Capture

A shell hook knows which command ran, but not what it printed. clipcmd gets the output in one of these ways:

- **PowerShell** — interactive PowerShell sessions start inside `clipcmd shell` automatically, so output capture just works in Windows Terminal and other consoles. It is skipped in VS Code (see below), when PowerShell was started to run something (`-Command`, `-File`, shortcuts such as "Developer PowerShell"), and when you turn it off with `"autoShell": false` in the config or `CLIPCMD_AUTOSHELL=0`. If the wrapper cannot start (e.g. `node-pty` is missing), the session simply continues without output capture. It adds roughly one PowerShell start-up to opening a tab.
- **VS Code** — the clipcmd VS Code extension reads each command's output from VS Code's shell integration and hands it to the daemon.
- **Anywhere else** (bash, zsh, fish) — run `clipcmd shell`.

`clipcmd shell` runs your shell inside a pseudo-terminal ([`node-pty`](https://github.com/microsoft/node-pty)) and mirrors the session into a headless terminal emulator (the one VS Code uses). The hooks mark where each command's output starts and ends, so what gets copied is exactly what the command displayed: colors and cursor movement are resolved, progress bars keep their final state, and long lines that wrapped are joined back into one line. Output is copied as plain text.

`node-pty` is an optional dependency that `npm install -g clipcmd` installs automatically (prebuilt binaries exist for Windows and macOS; Linux needs a C++ toolchain).

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

OSC 8 hyperlinks require terminal support to be clickable. In unsupported terminals the buttons still appear as plain text but cannot be clicked.

| Terminal              | OSC 8 Support                          |
|-----------------------|----------------------------------------|
| Windows Terminal      | ✅ Full support (1.24+: silent `clipcmd://` links; `clipcmd init` allows them in its settings) |
| VS Code Terminal      | ✅ Full support (works alongside VS Code's shell integration) |
| iTerm2 (macOS)        | ✅ Full support                        |
| GNOME Terminal        | ✅ Full support (v3.26+)               |
| macOS Terminal.app    | ⚠️ No OSC 8 support (buttons not clickable) |
| Hyper                 | ⚠️ Partial support                    |
| tmux                  | ⚠️ Requires passthrough config         |

### Windows

**PowerShell** (the default in Windows Terminal and VS Code) works out of the box. Run this from the PowerShell you use:

```powershell
clipcmd init      # detects Windows PowerShell 5.1 or PowerShell 7 and edits its $PROFILE
clipcmd start
```

`clipcmd init` also:

- registers `clipcmd://` links for your user account (under `HKCU\Software\Classes\clipcmd`, no admin rights). A click runs a tiny script with `wscript.exe` (no window) that tells the daemon what to copy.
- adds `"clipcmd"` to Windows Terminal's `safeUriSchemes` setting, so it does not ask for confirmation on every click. The original `settings.json` is backed up to `~/.config/clipcmd/backups/`, and `clipcmd uninstall` removes the entry again.

The hook works in any interactive PowerShell console that has PSReadLine (the default), including VS Code's terminal alongside VS Code's own PowerShell integration. It keeps your prompt (oh-my-posh, starship, posh-git, ...), `$?` and `$LASTEXITCODE` intact. Exit codes: `0`/`1` for PowerShell commands, the real exit code for native programs.

`clipcmd init` refuses to edit your profile while PowerShell's execution policy is `Restricted` or `AllSigned`, because PowerShell would then refuse to run the profile and print an error in every new window. It tells you how to allow local scripts for your account (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`); it never changes the policy itself.

**Git Bash** (bundled with [Git for Windows](https://gitforwindows.org/)) works too: run `clipcmd init bash` from Git Bash, and `clipcmd shell` for output capture.

**cmd.exe** is not supported: it has no way to run code before and after each command.

---

## Troubleshooting

**Clicking a button opens a browser tab**
The button is an http link: no `clipcmd://` handler is registered (run `clipcmd init` on Windows), or `"links": "http"` is set in the config. Existing buttons keep their old links; new commands get the new ones.

**Windows Terminal asks "open this link?" on every click**
Your Windows Terminal is older than 1.24, or `clipcmd init` could not edit its settings (it says so). Add `"safeUriSchemes": ["clipcmd"]` to the top level of Windows Terminal's `settings.json`.

**VS Code asks whether to allow `clipcmd` links**
Choose *Allow* once, or install the clipcmd VS Code extension, which allows them for you.

**Only `[COPY CMD]` and `[+]` are shown**
This terminal has no output capture: see [Output Capture](#output-capture). In VS Code, install the clipcmd VS Code extension; in PowerShell, check that `autoShell` is not turned off; elsewhere, run `clipcmd shell`.

**Buttons are not clickable**
Your terminal does not support OSC 8 hyperlinks. Switch to a supported terminal such as Windows Terminal, VS Code Terminal, iTerm2, or GNOME Terminal (v3.26+). See the compatibility table above.

**Daemon is not running**
Run `clipcmd start` to start the background daemon. You can verify it is running with `clipcmd status`. If it fails to start, `~/.config/clipcmd/daemon.log` says why.

**Hook not working after init**
Open a new terminal, or run `source ~/.zshrc` (zsh), `source ~/.bashrc` (bash), `source ~/.config/fish/config.fish` (fish), or `. $PROFILE` (PowerShell).

With PowerShell, `clipcmd init` writes to the profile of the edition it detects; Windows PowerShell 5.1 and PowerShell 7 have separate profiles, so run it from each one you use (or pass `powershell` / `pwsh`). The hook is inactive in the PowerShell ISE and in non-interactive runs (`powershell -Command ...`, scripts).

With bash, terminals that start *login* shells (macOS Terminal, Git Bash) read `~/.bash_profile` instead of `~/.bashrc`; `clipcmd init` warns when your `~/.bash_profile` does not load `~/.bashrc`. Add this line to `~/.bash_profile`:

```bash
[ -f ~/.bashrc ] && . ~/.bashrc
```

**No buttons after a command in parentheses**
In bash, a command that is only a subshell, such as `(cd /tmp && make)`, does not trigger the hook (bash runs no `DEBUG` trap for it). Commands like `cd /tmp && make` work.

**The terminal got slow after the daemon was stopped**
It should not: the hooks give up after 0.5–1 s and then skip the daemon for 30 seconds (10 commands in fish) before trying again.

---

## Configuration

Config is stored at `~/.config/clipcmd/config.json`. The directory is created automatically if it does not exist.

```json
{
  "port": 9666,
  "ringBufferSize": 200,
  "maxOutputBytes": 1048576,
  "links": "auto",
  "autoShell": true
}
```

| Key              | Default   | Description                                                           |
|------------------|-----------|-----------------------------------------------------------------------|
| `port`           | `9666`    | Preferred port for the daemon. Falls back to the next free port (up to +10). |
| `ringBufferSize` | `200`     | Maximum number of command blocks kept in memory (1–10000).            |
| `maxOutputBytes` | `1048576` | Output kept per block; longer output keeps its last bytes (0 disables capture). |
| `links`          | `"auto"`  | `"clipcmd"`: silent `clipcmd://` links; `"http"`: browser links; `"auto"`: `clipcmd://` when the Windows handler is registered. |
| `autoShell`      | `true`    | Start interactive PowerShell sessions inside `clipcmd shell` for output capture. |

If the config file is missing, corrupt, or has invalid values, `clipcmd` uses the built-in defaults for those values, logs a warning, and does not crash. `links` is applied to each new command; the others take effect when the daemon (or, for `autoShell`, a new PowerShell) starts.

The daemon writes its active port to `~/.config/clipcmd/port` (as `port:pid`) and operational logs to `~/.config/clipcmd/daemon.log` (rotated at 1 MB).

Environment variables: `CLIPCMD_CONFIG_DIR` uses a different directory for all of these files (the daemon, CLI, hooks and the VS Code extension all honor it); `CLIPCMD_AUTOSHELL=0` / `1` turns PowerShell's automatic `clipcmd shell` off / forces it; `CLIPCMD_POWERSHELL_PROFILE` makes `clipcmd init` / `uninstall` use a specific PowerShell profile file.

`clipcmd init` edits shell config files in place and keeps their encoding (UTF-8, UTF-8 with BOM, UTF-16 as written by Windows PowerShell's `>`, or legacy code pages) byte-for-byte outside the clipcmd block.

---

## Security

The daemon only listens on `127.0.0.1`, never on your network. Because any web page can make your browser send requests to `127.0.0.1`, the daemon rejects requests that carry browser cross-site markers (`Origin`, or `Sec-Fetch-Site` other than `none`) or an unexpected `Host` header (DNS rebinding). Clicking a copy button — a top-level navigation you started — is still allowed.

The `clipcmd://` handler only forwards the copy and `[+]` actions, with a plain query string, to the daemon registered in `~/.config/clipcmd/port`. A copy only happens for a command id that exists in the daemon's history.

---

## Development

```bash
npm install
npm test          # builds dist/, then runs unit, property and end-to-end tests
```

The end-to-end tests run the real CLI, a real bash (Git Bash on Windows), a real interactive PowerShell through a pseudo-console (Windows PowerShell 5.1, and PowerShell 7 when `pwsh` is installed or `CLIPCMD_TEST_PWSH` points at it), VS Code's real bash and PowerShell shell-integration scripts when VS Code is installed, a real PTY via `node-pty`, and on Windows the `clipcmd://` handler registered under a throwaway scheme name and opened the way terminals open links. The zsh and fish hook tests run when those shells are installed (or point `CLIPCMD_TEST_ZSH` / `CLIPCMD_TEST_FISH` at them). Tests never touch your real `~/.config/clipcmd`, shell config files, Windows Terminal settings, `clipcmd://` registration, or clipboard.

---

## How to Publish (for maintainers)

```bash
npm login
npm run build
npm publish
```

The `prepublishOnly` script runs the TypeScript build automatically before publishing. Only `dist/`, `bin/`, `hooks/`, and `README.md` are included in the published package.

---

## License

MIT
