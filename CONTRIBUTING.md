# Contributing to clipcmd

Thanks for helping! Bug reports, fixes and improvements are all welcome.

## Reporting a bug

Open an issue with:

- the output of `clipcmd doctor`,
- your OS, terminal (Windows Terminal, iTerm2, VS Code, ...) and shell with its version,
- what you did, what you expected, and what happened.

## Development setup

You need Node.js 20+ and git. The two packages are independent:

```bash
git clone https://github.com/Djain912/clipcmd.git
cd clipcmd/cli
npm install
npm test                  # builds dist/, runs unit, property and end-to-end tests

cd ../vscode-extension
npm install
npm test                  # unit tests, then integration tests inside a real VS Code
```

To try your working copy as your real `clipcmd`, run `npm link` in `cli/` (undo with `npm unlink -g clipcmd`), then `clipcmd init`.

The end-to-end tests drive real shells: bash (Git Bash on Windows), Windows PowerShell and PowerShell 7, and zsh and fish when installed. Tests that need a missing shell are skipped; CI runs everything on Windows, macOS and Linux.

### What the CLI tests run

The real CLI, real bash (Git Bash on Windows), zsh and fish when installed, a real interactive PowerShell through a pseudo-console (Windows PowerShell 5.1, and PowerShell 7 when `pwsh` is installed or `CLIPCMD_TEST_PWSH` points at it), VS Code's real bash and PowerShell shell-integration scripts when VS Code is installed, a real PTY via `node-pty`, and the `clipcmd://` handler registered under a throwaway scheme name and opened through ShellExecute, both directly (as VS Code opens links) and through the shortcuts Windows Terminal buttons use. On Windows they also compile the "Copied" tag and lay it out; only CI actually shows one. Tests never touch your real `~/.config/clipcmd`, shell config files, Windows Terminal settings, link handler registration or clipboard, never show tags on your screen, and never start daemons from the hooks (`cli/test/e2e/isolation.test.ts` guards this).

### Working on the VS Code extension

In `vscode-extension/`, press **F5** (*Run Extension*) to open an Extension Development Host with the extension loaded.

```bash
npm run test:unit          # CLI runner, daemon client and output capture, against real local HTTP servers
npm run test:integration   # launches VS Code and runs the tests inside it (incl. a real terminal)
npm run package            # builds clipcmd-<version>.vsix
```

- `test:integration` downloads the latest stable VS Code into `.vscode-test/` unless `VSCODE_EXECUTABLE_PATH` points at an installed one (or `VSCODE_TEST_VERSION` picks a version, 1.101 or newer). It uses its own user-data directory, so your VS Code settings are never touched.
- Set `CLIPCMD_DAEMON_ENTRY` to the CLI's `dist/daemon/index.js` to also run the unit tests against the real daemon.
- Tests use a temporary `CLIPCMD_CONFIG_DIR`, so a daemon you are running is never touched.

## Ground rules

- **Never break the user's shell.** Hooks must stay silent and fast when the daemon is missing, slow or broken, must keep `$?`, exit codes, the prompt and other shell integrations intact, and must only use ASCII.
- **Tests never touch the real setup.** No test may modify the real `~/.config/clipcmd`, shell config files, PowerShell profile, Windows Terminal settings, `clipcmd://` registration or clipboard, or leave processes behind. `cli/vitest.config.ts` isolates the environment and `cli/test/e2e/isolation.test.ts` guards it; keep both passing.
- **Cover the change with a test**, preferably one that runs the real shell or CLI.
- Match the surrounding code style; keep comments about *why*, not *what*.
- Add a line to the package's `CHANGELOG.md` under an `Unreleased` heading.

## Pull requests

1. Fork and branch from `main`.
2. Make the change with tests; run `npm test` in the package you changed.
3. Open a pull request describing the problem and the fix. CI must pass on all three platforms.

## Releasing

Maintainers: see [RELEASING.md](RELEASING.md).
