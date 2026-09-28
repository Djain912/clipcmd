# Requirements Document

## Introduction

`clipcmd` is a production-ready NPM package that provides a CLI tool for automatically injecting clickable "Copy" buttons into the terminal after every shell command execution. The tool allows developers to copy terminal commands and their raw output with a single click, eliminating the need to manually scroll, select, and copy text. It operates via a background daemon that communicates with shell hooks, preserves all raw terminal text (including ANSI codes, newlines, spaces, and tabs), and supports Zsh, Bash, and Fish shells. The package is written in TypeScript, targets Node.js >= 18, and is published to NPM.

## Glossary

- **Daemon**: The background Node.js HTTP server process started by `clipcmd start`, listening on port 9666 (or next available port).
- **Block**: A record of one shell command execution, containing the command string, its raw output, a unique block ID, timestamp, and working directory.
- **Ring_Buffer**: An in-memory fixed-size circular buffer holding at most 200 Blocks, discarding the oldest when full.
- **OSC_8_Button**: A clickable hyperlink rendered in the terminal using the OSC 8 escape sequence, triggering an HTTP request to the Daemon when clicked.
- **Shell_Hook**: A snippet of shell code injected into the user's shell config file (`.zshrc`, `.bashrc`, or `config.fish`) that notifies the Daemon when a command starts and ends.
- **Multi_Select_Queue**: An ordered in-memory list of Block IDs that the user has added for batch copying.
- **CLI**: The `clipcmd` command-line interface binary registered in the `bin` field of `package.json`.
- **Config_File**: A JSON file at `~/.config/clipcmd/config.json` storing user configuration.
- **Port_File**: A file at `~/.config/clipcmd/port` storing the active port number the Daemon is listening on.
- **Daemon_Log**: A log file at `~/.config/clipcmd/daemon.log` where the Daemon writes operational logs.
- **PTY_Wrapper**: An optional shell wrapper using `node-pty` that captures terminal output more accurately (Phase 2).
- **Clipboard**: The system clipboard, managed cross-platform via the `clipboardy` npm package.
- **Shell_Detector**: The module responsible for identifying the user's active shell from environment variables.
- **Installer**: The module responsible for writing and removing Shell_Hooks from shell config files.

## Requirements

### Requirement 1: Daemon Lifecycle Management

**User Story:** As a developer, I want to start, stop, and check the status of the clipcmd daemon, so that I can control when the copy-button feature is active.

#### Acceptance Criteria

1. WHEN the user runs `clipcmd start`, THE CLI SHALL fork a detached background process running the Daemon and exit immediately, leaving the Daemon running independently of the terminal session.
2. WHEN the Daemon starts, THE Daemon SHALL attempt to bind an HTTP server to port 9666 and, IF port 9666 is unavailable, THE Daemon SHALL try ports 9667, 9668, and so on until a free port is found.
3. WHEN the Daemon successfully binds to a port, THE Daemon SHALL write the active port number as a plain integer to the Port_File at `~/.config/clipcmd/port`.
4. WHEN the user runs `clipcmd stop`, THE CLI SHALL read the Port_File, send a shutdown signal to the Daemon, and verify the Daemon process has terminated.
5. WHEN the user runs `clipcmd status`, THE CLI SHALL read the Port_File and report whether the Daemon is running, including the active port number and process ID.
6. WHEN the Daemon receives SIGTERM, THE Daemon SHALL close the HTTP server, release the bound port, delete the Port_File, and exit cleanly.
7. THE Daemon SHALL write all operational events, errors, and lifecycle messages to the Daemon_Log at `~/.config/clipcmd/daemon.log`.
8. WHEN the Daemon starts, THE Daemon SHALL initialize the Ring_Buffer with a maximum capacity of 200 Blocks.

---

### Requirement 2: Shell Integration and Hook Installation

**User Story:** As a developer, I want `clipcmd init` to automatically configure my shell, so that copy buttons appear after every command without manual setup.

#### Acceptance Criteria

1. WHEN the user runs `clipcmd init`, THE Shell_Detector SHALL identify the user's active shell by reading the `SHELL` environment variable and matching it to one of: `zsh`, `bash`, or `fish`.
2. WHEN the shell is identified as `zsh`, THE Installer SHALL append the Zsh Shell_Hook to `~/.zshrc` surrounded by the marker comments `# === CLIPCMD HOOK START ===` and `# === CLIPCMD HOOK END ===`.
3. WHEN the shell is identified as `bash`, THE Installer SHALL append the Bash Shell_Hook to `~/.bashrc` surrounded by the marker comments `# === CLIPCMD HOOK START ===` and `# === CLIPCMD HOOK END ===`.
4. WHEN the shell is identified as `fish`, THE Installer SHALL append the Fish Shell_Hook to `~/.config/fish/config.fish` surrounded by the marker comments `# === CLIPCMD HOOK START ===` and `# === CLIPCMD HOOK END ===`.
5. WHEN `clipcmd init` is run on a shell config file that already contains the `CLIPCMD HOOK START` marker, THE Installer SHALL replace the existing hook block rather than append a duplicate.
6. WHEN the identified shell is not one of `zsh`, `bash`, or `fish`, THE CLI SHALL display an error message listing the supported shells and exit with a non-zero exit code.
7. THE Shell_Hook SHALL use `preexec` and `precmd` (for Zsh/Bash) or their Fish equivalents to notify the Daemon via HTTP requests when a command begins and ends.
8. WHEN the Daemon is not running and the Shell_Hook attempts to contact the Daemon, THE Shell_Hook SHALL fail silently without printing any error output or blocking the terminal.
9. WHEN the user runs `clipcmd uninstall`, THE Installer SHALL remove the entire hook block (from `CLIPCMD HOOK START` to `CLIPCMD HOOK END`) from the detected shell config file.

---

### Requirement 3: Command Lifecycle Signaling

**User Story:** As a developer, I want the shell hooks to notify the daemon when each command starts and ends, so that the daemon can capture the command string and output accurately.

#### Acceptance Criteria

1. WHEN a shell command begins execution, THE Shell_Hook SHALL send an HTTP GET request to `http://localhost:{port}/start?cmd={URL_ENCODED_CMD}&pwd={URL_ENCODED_PATH}` where `{port}` is read from the Port_File.
2. WHEN a shell command finishes execution, THE Shell_Hook SHALL send an HTTP GET request to `http://localhost:{port}/end?exitCode={N}` where `{N}` is the integer exit code of the completed command.
3. WHEN the Daemon receives a `/start` request, THE Daemon SHALL create a new Block with a unique ID, the decoded command string, the working directory, and the current timestamp, and mark it as in-progress.
4. WHEN the Daemon receives an `/end` request, THE Daemon SHALL finalize the current in-progress Block with the exit code, extract the raw output from the capture source, add the Block to the Ring_Buffer, and emit the OSC_8_Buttons to the terminal.
5. WHEN the Ring_Buffer is at capacity and a new Block is added, THE Ring_Buffer SHALL discard the oldest Block to make room for the new one.
6. WHEN a `/start` request arrives while a Block is already in-progress, THE Daemon SHALL finalize the previous Block before creating the new one.

---

### Requirement 4: Output Capture (Phase 1 — File Tail)

**User Story:** As a developer, I want the daemon to capture my command's raw output, so that the [COPY OUTPUT] button copies exactly what appeared in the terminal.

#### Acceptance Criteria

1. THE Daemon SHALL implement Phase 1 output capture by tailing a temp log file written to by the shell via `script` or `tee` piping, reading bytes written between the `/start` and `/end` timestamps.
2. WHEN a Block is finalized, THE Daemon SHALL store the raw captured bytes as the Block's output field, preserving all whitespace, newlines, tabs, and ANSI escape sequences without modification.
3. WHEN no output was produced between `/start` and `/end`, THE Daemon SHALL store an empty string as the Block's output field.
4. THE Daemon SHALL not add any prefix, suffix, label, markdown formatting, or code block markers to the captured output.

---

### Requirement 5: OSC 8 Copy Buttons

**User Story:** As a developer, I want clickable copy buttons to appear after every command, so that I can copy the command or its output with a single click.

#### Acceptance Criteria

1. WHEN a Block is finalized, THE Daemon SHALL print three OSC_8_Buttons to the terminal's stderr: `[COPY CMD]`, `[COPY OUTPUT]`, and `[+]`.
2. THE Daemon SHALL implement each OSC_8_Button as an OSC 8 hyperlink in the format `\x1b]8;;{url}\x07{label}\x1b]8;;\x07` where `{url}` is an HTTP URL targeting the Daemon's copy or select endpoint.
3. THE `[COPY CMD]` button's URL SHALL target `http://localhost:{port}/copy?id={BLOCK_ID}&type=cmd`.
4. THE `[COPY OUTPUT]` button's URL SHALL target `http://localhost:{port}/copy?id={BLOCK_ID}&type=output`.
5. THE `[+]` button's URL SHALL target `http://localhost:{port}/select?id={BLOCK_ID}`.
6. WHEN the Daemon receives a `/copy` request with `type=cmd`, THE Daemon SHALL write the Block's command string to the Clipboard within 50ms of receiving the request.
7. WHEN the Daemon receives a `/copy` request with `type=output`, THE Daemon SHALL write the Block's raw output string to the Clipboard within 50ms of receiving the request.
8. WHEN copying a command, THE Daemon SHALL write only the bare command string to the Clipboard with no surrounding labels, markdown, or formatting.
9. WHEN copying output, THE Daemon SHALL write only the bare output string to the Clipboard with no surrounding labels, markdown, or formatting.
10. WHEN the Daemon receives a `/copy` request for a Block ID that no longer exists in the Ring_Buffer, THE Daemon SHALL respond with HTTP 404 and write nothing to the Clipboard.

---

### Requirement 6: Multi-Select Batch Copy

**User Story:** As a developer, I want to select multiple past command blocks and copy them all at once, so that I can collect a sequence of commands and outputs into my clipboard.

#### Acceptance Criteria

1. WHEN the Daemon receives a `/select?id={BLOCK_ID}` request, THE Daemon SHALL add the Block ID to the end of the Multi_Select_Queue if it is not already present.
2. WHEN the Daemon receives a `/select?id={BLOCK_ID}` request for a Block ID already in the Multi_Select_Queue, THE Daemon SHALL remove it from the Multi_Select_Queue (toggle behavior).
3. WHEN the Daemon receives a `/copy-selected` request, THE Daemon SHALL concatenate all blocks in the Multi_Select_Queue in chronological order using the format `$ {command}\n{output}\n\n` for each block and write the result to the Clipboard.
4. WHEN the `/copy-selected` operation completes, THE Daemon SHALL clear the Multi_Select_Queue.
5. WHEN the Daemon receives a `/copy-selected` request with an empty Multi_Select_Queue, THE Daemon SHALL write an empty string to the Clipboard and respond with HTTP 200.
6. WHEN a Block is evicted from the Ring_Buffer, THE Daemon SHALL also remove that Block's ID from the Multi_Select_Queue if present.

---

### Requirement 7: Raw Text Preservation

**User Story:** As a developer, I want copied text to be identical to what appeared in the terminal, so that I can paste it into other tools without unwanted formatting.

#### Acceptance Criteria

1. THE Daemon SHALL preserve all ANSI escape sequences in copied output text exactly as captured.
2. THE Daemon SHALL preserve all whitespace characters — spaces, tabs (`\t`), newlines (`\n`), and carriage returns (`\r`) — in copied output text without modification.
3. THE Daemon SHALL NOT add any labels such as "Command:", "Output:", "Result:", or similar text to any copied content.
4. THE Daemon SHALL NOT wrap copied content in markdown code fences, HTML tags, or any other formatting.
5. WHEN copying via multi-select, THE Daemon SHALL format each block strictly as `$ {command}\n{output}\n\n` with no additional decoration.

---

### Requirement 8: Configuration Management

**User Story:** As a developer, I want clipcmd to store its configuration in a predictable location, so that I can inspect and modify settings without side effects elsewhere on my system.

#### Acceptance Criteria

1. THE CLI SHALL store all configuration in `~/.config/clipcmd/config.json` and SHALL NOT write configuration data to any other location outside the `~/.config/clipcmd/` directory.
2. WHEN `~/.config/clipcmd/` does not exist, THE CLI SHALL create the directory before writing any files to it.
3. THE Config_File SHALL be valid JSON and SHALL include at minimum the configured daemon port preference and any user-overridable settings.
4. WHEN the Config_File is missing or corrupt, THE CLI SHALL use built-in defaults and SHALL NOT crash.
5. THE CLI SHALL NOT modify, create, or delete files outside of `~/.config/clipcmd/`, the shell config files targeted during `init`, and the package installation directory.

---

### Requirement 9: Cross-Platform Clipboard Support

**User Story:** As a developer using macOS, Linux, or Windows, I want clipboard operations to work on my platform, so that copied text reaches my system clipboard regardless of OS.

#### Acceptance Criteria

1. THE Daemon SHALL use the `clipboardy` npm package for all Clipboard write operations.
2. WHEN a Clipboard write operation fails due to a platform error, THE Daemon SHALL log the error to the Daemon_Log and respond to the HTTP request with HTTP 500.
3. THE Daemon SHALL support clipboard operations on macOS, Linux (with X11 or Wayland), and Windows without requiring the user to install additional system dependencies beyond `clipboardy`'s documented requirements.

---

### Requirement 10: HTTP API (Daemon Endpoints)

**User Story:** As a developer or integrator, I want the daemon to expose a well-defined HTTP API, so that shell hooks and OSC 8 links can communicate with it reliably.

#### Acceptance Criteria

1. THE Daemon SHALL implement its HTTP server using only the native `node:http` module with no third-party HTTP framework dependencies.
2. THE Daemon SHALL expose the following endpoints: `GET /start`, `GET /end`, `GET /copy`, `GET /select`, `GET /copy-selected`, and `GET /health`.
3. WHEN the Daemon receives a `GET /health` request, THE Daemon SHALL respond with HTTP 200 and the body `{"status":"ok"}`.
4. WHEN the Daemon receives a request to an undefined route, THE Daemon SHALL respond with HTTP 404.
5. WHEN the Daemon receives a `/copy` request, THE Daemon SHALL respond with HTTP 200 within 50ms.
6. WHEN the Daemon receives a malformed query parameter on any endpoint, THE Daemon SHALL respond with HTTP 400 and a plain-text error description.

---

### Requirement 11: NPM Package and TypeScript Build

**User Story:** As a developer, I want to install clipcmd via NPM and use it immediately, so that setup is fast and the package is ready for production distribution.

#### Acceptance Criteria

1. THE CLI binary SHALL be registered in `package.json` under the `bin` field as `"clipcmd": "bin/clipcmd.js"`.
2. THE package.json `files` field SHALL include only `dist/`, `bin/`, `hooks/`, and `README.md`, excluding source files, test files, and development configuration.
3. THE package.json SHALL include a `prepublishOnly` script that runs `npm run build`.
4. THE TypeScript compiler SHALL be configured with `strict: true` in `tsconfig.json`.
5. THE build output SHALL be compiled JavaScript files in `dist/` accompanied by `.d.ts` type declaration files.
6. THE package SHALL declare `"engines": { "node": ">=18.0.0" }` in `package.json`.
7. THE package SHALL declare `"license": "MIT"` in `package.json`.
8. THE package SHALL include a `.gitignore` excluding `node_modules/`, `dist/`, and `*.log` files.
9. THE package SHALL include a `.npmignore` excluding `src/`, `*.ts` source files (excluding `.d.ts`), test files, and development-only configuration.
10. THE package SHALL include a `README.md` documenting installation via `npx clipcmd init`, the `clipcmd start` command, `clipcmd stop`, `clipcmd status`, usage instructions, and a terminal compatibility list covering iTerm2, VS Code Terminal, Windows Terminal, and GNOME Terminal.

---

### Requirement 12: PTY Wrapper (Phase 2 — Optional)

**User Story:** As a developer who wants more accurate output capture, I want an optional PTY-based shell wrapper, so that I can opt into higher-fidelity terminal output recording.

#### Acceptance Criteria

1. WHEN the user runs `clipcmd shell`, THE CLI SHALL spawn the user's default shell inside a `node-pty` pseudo-terminal session that routes all I/O through the Daemon's capture pipeline.
2. WHERE `node-pty` is installed as an optional dependency, THE PTY_Wrapper SHALL capture all bytes written to the PTY and make them available to the Daemon for output extraction.
3. WHERE `node-pty` is not installed, THE CLI SHALL print a clear message instructing the user to install it and exit with a non-zero exit code.
4. THE PTY_Wrapper SHALL pass all terminal resize events (SIGWINCH) through to the child shell process to maintain correct terminal dimensions.
