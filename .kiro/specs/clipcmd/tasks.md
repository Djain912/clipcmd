# Implementation Plan: clipcmd

## Overview

Implement `clipcmd` incrementally, starting with the foundational data structures and utilities, building up through the daemon core, CLI commands, shell integration, and finally wiring everything together into the publishable NPM package. Each task builds on the previous ones with no orphaned code.

## Tasks

- [x] 1. Project scaffolding and TypeScript configuration
  - Initialize `package.json` with name `clipcmd`, `"engines": { "node": ">=18.0.0" }`, `"license": "MIT"`, `bin` field pointing to `bin/clipcmd.js`, and `files` field including `dist/`, `bin/`, `hooks/`, `README.md`
  - Add `prepublishOnly` script running `npm run build`; add `build` script running `tsc`; add `test` script running `vitest --run`
  - Create `tsconfig.json` with `strict: true`, `outDir: dist`, `declaration: true`, `target: ES2022`, `module: CommonJS`, `moduleResolution: node`
  - Create `src/` directory structure: `src/cli/`, `src/daemon/`, `src/installer/`, `src/config/`
  - Create `bin/clipcmd.js` as a thin shebang wrapper: `#!/usr/bin/env node\nrequire('../dist/cli/index.js')`
  - Create `hooks/` directory with placeholder files: `hooks/zsh.sh`, `hooks/bash.sh`, `hooks/fish.fish`
  - Create `.gitignore` excluding `node_modules/`, `dist/`, `*.log`
  - Create `.npmignore` excluding `src/`, `*.ts` source files (not `.d.ts`), test files, dev config
  - Install dev dependencies: `typescript`, `vitest`, `fast-check`, `@types/node`
  - Install runtime dependencies: `clipboardy`
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

- [x] 2. Core data models and Ring Buffer
  - [x] 2.1 Define `Block` interface and `RingBuffer` class in `src/daemon/ringBuffer.ts`
    - Implement `push(block)` returning the evicted Block or null; `get(id)`; `getAll()`; `size`; `capacity`
    - Store blocks in a fixed-length array with a head pointer; overwrite oldest slot when full
    - _Requirements: 3.3, 3.5, 6.6_

  - [ ]* 2.2 Write property test for Ring Buffer capacity invariant
    - **Property 1: Ring Buffer capacity invariant**
    - **Validates: Requirements 3.5**
    - Generate arbitrary arrays of Blocks (lengths 0–500) and push them all; assert `buffer.size <= buffer.capacity` holds after every push
    - `// Feature: clipcmd, Property 1: Ring Buffer capacity invariant`

  - [ ]* 2.3 Write property test for Ring Buffer FIFO eviction
    - **Property 2: Ring Buffer FIFO eviction**
    - **Validates: Requirements 3.5**
    - Fill a buffer of capacity N beyond capacity; assert the evicted block is always the oldest pushed, and the newest entry is the one just pushed
    - `// Feature: clipcmd, Property 2: Ring Buffer FIFO eviction`

  - [ ]* 2.4 Write unit tests for Ring Buffer
    - Test get() on unknown ID returns undefined
    - Test push into empty buffer returns null eviction
    - Test getAll() returns all blocks in insertion order

- [x] 3. Config Manager
  - [x] 3.1 Implement `ConfigManager` in `src/config/config.ts`
    - Define `ClipCmdConfig` interface: `{ port: number; ringBufferSize: number }`
    - `load()`: read `~/.config/clipcmd/config.json`; on missing or JSON parse error return `DEFAULT_CONFIG = { port: 9666, ringBufferSize: 200 }`
    - `save(config)`: create directory if absent, write JSON with `JSON.stringify(config, null, 2)`
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 3.2 Write property test for config round-trip
    - **Property 9: Config round-trip**
    - **Validates: Requirements 8.3**
    - Generate arbitrary `ClipCmdConfig` objects (arbitrary port 1024–65535, arbitrary ringBufferSize 1–1000); serialize to JSON and deserialize; assert deep equality
    - `// Feature: clipcmd, Property 9: Config round-trip`

  - [ ]* 3.3 Write unit tests for ConfigManager
    - Test missing file → DEFAULT_CONFIG returned
    - Test corrupt JSON → DEFAULT_CONFIG returned (no throw)
    - Test save then load round-trip with concrete values

- [x] 4. Shell Detector
  - [x] 4.1 Implement `ShellDetector` in `src/installer/shellDetector.ts`
    - Read `process.env.SHELL`, extract `path.basename`, match case-insensitively against `['zsh', 'bash', 'fish']`
    - Throw `UnsupportedShellError` (custom error subclass) when no match
    - Export `SupportedShell` type: `'zsh' | 'bash' | 'fish'`
    - _Requirements: 2.1, 2.6_

  - [ ]* 4.2 Write unit tests for ShellDetector
    - Test `/bin/zsh` → `'zsh'`; `/usr/bin/bash` → `'bash'`; `/usr/bin/fish` → `'fish'`
    - Test unknown shell → throws `UnsupportedShellError`
    - Test missing SHELL env var → throws `UnsupportedShellError`

- [x] 5. Installer (shell hook injection)
  - [x] 5.1 Implement `Installer` in `src/installer/installer.ts`
    - Define `HOOK_START_MARKER = '# === CLIPCMD HOOK START ==='` and `HOOK_END_MARKER = '# === CLIPCMD HOOK END ==='`
    - `getConfigPath(shell)`: return the correct shell config file path per shell
    - `install(shell)`: read hook file from `hooks/{shell}.{ext}`, read config file (create if missing), replace existing hook block if present, else append; write result
    - `uninstall(shell)`: read config file, remove entire block from HOOK_START to HOOK_END inclusive, preserve all surrounding content; write result
    - `isInstalled(shell)`: return true if HOOK_START_MARKER is present in config file
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.9_

  - [ ]* 5.2 Write property test for hook idempotent installation
    - **Property 7: Hook idempotent installation**
    - **Validates: Requirements 2.5**
    - Generate arbitrary file contents (strings with arbitrary lines); run `install` twice on that content; assert the resulting file contains the CLIPCMD hook block exactly once
    - `// Feature: clipcmd, Property 7: Hook idempotent installation`

  - [ ]* 5.3 Write property test for hook clean uninstall
    - **Property 8: Hook clean uninstall**
    - **Validates: Requirements 2.9**
    - Generate arbitrary file contents; insert a hook block; run `uninstall`; assert neither marker appears in the result and all content outside the hook block is preserved verbatim
    - `// Feature: clipcmd, Property 8: Hook clean uninstall`

  - [ ]* 5.4 Write unit tests for Installer
    - Test install on empty file adds hook with markers
    - Test install on file with existing hook replaces, not duplicates
    - Test uninstall on file without hook is a no-op (no crash, file unchanged)

- [x] 6. Write shell hook files
  - [x] 6.1 Write `hooks/zsh.sh`
    - Implement `preexec` function: read port from `~/.config/clipcmd/port`; send `GET /start?cmd=URL_ENCODED_CMD&pwd=URL_ENCODED_PWD` silently (curl with timeout, discard stdout/stderr)
    - Implement `precmd` function: send `GET /end?exitCode=$?` silently
    - Wrap with guards so the hook is a no-op if the port file does not exist or daemon is unreachable
    - _Requirements: 2.2, 2.7, 2.8, 3.1, 3.2_

  - [x] 6.2 Write `hooks/bash.sh`
    - Implement using `DEBUG` trap for preexec equivalent and `PROMPT_COMMAND` for precmd equivalent
    - Same silent HTTP call pattern as Zsh hook
    - _Requirements: 2.3, 2.7, 2.8, 3.1, 3.2_

  - [x] 6.3 Write `hooks/fish.fish`
    - Implement using `fish_preexec` and `fish_postexec` event functions
    - Same silent HTTP call pattern; use `curl` or `fish`'s built-in HTTP if available
    - _Requirements: 2.4, 2.7, 2.8, 3.1, 3.2_

- [x] 7. OSC 8 emitter and button builder
  - [x] 7.1 Implement `buildOsc8Button` and `printButtons` in `src/daemon/osc8.ts`
    - `buildOsc8Button(label, url)`: return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
    - `printButtons(block, port)`: write three buttons to `process.stderr` on one line: `[COPY CMD]`, `[COPY OUTPUT]`, `[+]` with their respective URLs
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 7.2 Write property test for OSC 8 button format
    - **Property 11: OSC 8 button format correctness**
    - **Validates: Requirements 5.2**
    - Generate arbitrary label strings and URL strings; call `buildOsc8Button`; assert the result matches the exact pattern `\x1b]8;;{url}\x07{label}\x1b]8;;\x07`
    - `// Feature: clipcmd, Property 11: OSC 8 button format correctness`

  - [ ]* 7.3 Write unit tests for OSC 8 emitter
    - Test `printButtons` produces exactly three button sequences in one call
    - Test `[COPY CMD]` URL contains `type=cmd` and the block ID
    - Test `[COPY OUTPUT]` URL contains `type=output` and the block ID
    - Test `[+]` URL targets `/select`

- [x] 8. Clipboard writer
  - [x] 8.1 Implement `ClipboardWriter` in `src/daemon/clipboard.ts`
    - Import `clipboardy`; implement `write(text: string): Promise<void>`
    - Catch platform errors; wrap in `ClipboardError` with original cause; re-throw
    - _Requirements: 9.1, 9.2_

  - [ ]* 8.2 Write unit tests for ClipboardWriter
    - Test successful write delegates to clipboardy
    - Test clipboardy failure → throws `ClipboardError`

- [x] 9. Multi-Select Queue module
  - [x] 9.1 Implement `MultiSelectQueue` in `src/daemon/multiSelectQueue.ts`
    - `toggle(id)`: add if absent, remove if present
    - `getAll()`: return ordered copy of IDs
    - `remove(id)`: remove a specific ID (used on eviction)
    - `clear()`: empty the queue
    - `has(id)`: membership check
    - _Requirements: 6.1, 6.2, 6.4, 6.6_

  - [ ]* 9.2 Write property test for Multi_Select_Queue toggle idempotence
    - **Property 3: Multi_Select_Queue toggle idempotence**
    - **Validates: Requirements 6.1, 6.2**
    - Generate arbitrary Block IDs; toggle each ID twice; assert the queue state is the same as before either toggle
    - `// Feature: clipcmd, Property 3: Multi_Select_Queue toggle idempotence`

  - [ ]* 9.3 Write property test for Multi_Select_Queue uniqueness invariant
    - **Property 4: Multi_Select_Queue uniqueness invariant**
    - **Validates: Requirements 6.1, 6.2**
    - Generate arbitrary sequences of toggle calls (with possible duplicate IDs); assert after all operations the queue contains each ID at most once
    - `// Feature: clipcmd, Property 4: Multi_Select_Queue uniqueness invariant`

  - [ ]* 9.4 Write unit tests for MultiSelectQueue
    - Test toggle on absent ID adds it
    - Test toggle on present ID removes it
    - Test clear() empties the queue
    - Test remove() on absent ID is a no-op

- [x] 10. Checkpoint — core modules complete
  - Ensure all tests pass. Build project with `npm run build` and confirm no TypeScript errors. Ask the user if questions arise.

- [x] 11. Output capture (Phase 1 — file tail)
  - [x] 11.1 Implement `FileTailCapture` in `src/daemon/capture.ts` implementing the `CaptureSource` interface
    - `startCapture(blockId)`: record current byte offset of `~/.config/clipcmd/output.tmp` (or 0 if missing)
    - `endCapture(blockId)`: read bytes from recorded offset to current EOF; return as string preserving all bytes
    - Handle missing/empty file by returning empty string
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 11.2 Write unit tests for FileTailCapture
    - Test empty file → returns `""`
    - Test file with content written between start and end returns exactly those bytes
    - Test file with ANSI escape sequences preserves them verbatim

- [ ] 12. Daemon HTTP server
  - [x] 12.1 Implement `DaemonServer` in `src/daemon/server.ts` using `node:http`
    - Port-scan from configured port (default 9666); bind to first available port up to +10
    - Write port to Port_File on successful bind
    - Register route handlers: `/start`, `/end`, `/copy`, `/select`, `/copy-selected`, `/health`, `/shutdown`
    - Return HTTP 404 for unknown routes; HTTP 400 for malformed query params
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6, 1.2, 1.3_

  - [ ] 12.2 Implement `/start` handler
    - Parse `cmd` and `pwd` from query string (URL-decode both)
    - If a Block is currently in-progress, finalize it first (call end-capture, add to ring buffer, print buttons)
    - Create new Block with UUID v4 id, decoded command, pwd, `Date.now()`, `inProgress: true`
    - Start output capture for the new block
    - Respond HTTP 200
    - _Requirements: 3.3, 3.6_

  - [x] 12.3 Implement `/end` handler
    - Parse `exitCode` from query; validate it is an integer
    - Finalize the current in-progress Block: call `endCapture`, set `output`, `exitCode`, `inProgress: false`
    - Push Block to Ring_Buffer; if a Block was evicted, remove it from Multi_Select_Queue
    - Call `printButtons(block, port)`
    - Respond HTTP 200
    - _Requirements: 3.4, 6.6_

  - [x] 12.4 Implement `/copy` handler
    - Parse `id` and `type` from query; validate both present and `type` is `cmd` or `output`
    - Look up Block in Ring_Buffer; if not found respond HTTP 404
    - Write `block.command` (for `type=cmd`) or `block.output` (for `type=output`) to Clipboard — bare string, no modification
    - Respond HTTP 200
    - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10, 7.1, 7.2, 7.3, 7.4_

  - [x] 12.5 Implement `/select` handler
    - Parse `id` from query; look up Block in Ring_Buffer; if not found respond HTTP 404
    - Toggle Block ID in Multi_Select_Queue
    - Respond HTTP 200
    - _Requirements: 6.1, 6.2_

  - [x] 12.6 Implement `/copy-selected` handler
    - Read all IDs from Multi_Select_Queue; look up each Block in Ring_Buffer
    - Concatenate as `$ {command}\n{output}\n\n` in queue (chronological) order
    - Write result to Clipboard (empty string if queue empty)
    - Clear the Multi_Select_Queue
    - Respond HTTP 200
    - _Requirements: 6.3, 6.4, 6.5, 7.5_

  - [x] 12.7 Implement SIGTERM handler
    - Register `process.on('SIGTERM', ...)`: close HTTP server, delete Port_File, call `process.exit(0)`
    - _Requirements: 1.6_

  - [ ]* 12.8 Write property test for copy does not mutate output
    - **Property 6: Copy does not mutate output**
    - **Validates: Requirements 5.7, 7.1, 7.2**
    - Generate arbitrary strings (including ANSI escape sequences, unicode, embedded newlines, tabs); store as block output; invoke copy handler; assert clipboard receives byte-identical string
    - `// Feature: clipcmd, Property 6: Copy does not mutate output`

  - [ ]* 12.9 Write property test for multi-select batch copy format
    - **Property 5: Multi-select batch copy format**
    - **Validates: Requirements 6.3, 7.5**
    - Generate arbitrary arrays of Blocks; select all; invoke `/copy-selected`; assert clipboard text equals exact concatenation of `$ {command}\n{output}\n\n` per block in order
    - `// Feature: clipcmd, Property 5: Multi-select batch copy format`

  - [ ]* 12.10 Write property test for evicted Block removed from Multi_Select_Queue
    - **Property 10: Evicted Block removed from Multi_Select_Queue**
    - **Validates: Requirements 6.6**
    - Generate sequences of blocks pushed past ring buffer capacity with some selected; assert after each push, any evicted block's ID is absent from the Multi_Select_Queue
    - `// Feature: clipcmd, Property 10: Evicted Block removed from Multi_Select_Queue`

  - [ ]* 12.11 Write unit tests for HTTP endpoints
    - Test `/health` → HTTP 200, body `{"status":"ok"}`
    - Test unknown route → HTTP 404
    - Test `/copy` with missing `id` → HTTP 400
    - Test `/copy` with unknown Block ID → HTTP 404
    - Test `/copy-selected` on empty queue → HTTP 200, clipboard receives `""`

- [x] 13. Daemon entry point and logger
  - [x] 13.1 Implement daemon entry point `src/daemon/index.ts`
    - Load `ConfigManager.load()` for port preference
    - Initialize `RingBuffer`, `MultiSelectQueue`, `FileTailCapture`, `DaemonServer`
    - Write PID to Port_File alongside port (format: `{port}:{pid}`)
    - Route all operational events and errors to `Daemon_Log` via a simple `log(msg)` helper that appends timestamped lines to `~/.config/clipcmd/daemon.log`
    - _Requirements: 1.7, 1.8_

- [ ] 14. CLI commands
  - [x] 14.1 Implement `clipcmd start` in `src/cli/commands/start.ts`
    - Spawn `node dist/daemon/index.js` with `{ detached: true, stdio: 'ignore' }` and call `child.unref()`
    - Print confirmation message and exit
    - _Requirements: 1.1_

  - [x] 14.2 Implement `clipcmd stop` in `src/cli/commands/stop.ts`
    - Read Port_File; extract port and PID
    - Send `GET /shutdown` to Daemon; wait up to 2 seconds for port to close; print result
    - If Port_File missing, print "Daemon is not running" and exit 0
    - _Requirements: 1.4_

  - [x] 14.3 Implement `clipcmd status` in `src/cli/commands/status.ts`
    - Read Port_File; send `/health`; print port, PID, and running status
    - If Port_File missing or `/health` fails, report "Daemon is not running"
    - _Requirements: 1.5_

  - [x] 14.4 Implement `clipcmd init` in `src/cli/commands/init.ts`
    - Call `ShellDetector.detect()`; catch `UnsupportedShellError` → print supported list, exit 1
    - Call `Installer.install(shell)`; print success message with reload instructions
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 14.5 Implement `clipcmd uninstall` in `src/cli/commands/uninstall.ts`
    - Detect shell; call `Installer.uninstall(shell)`; print confirmation
    - _Requirements: 2.9_

  - [x] 14.6 Implement CLI entry point `src/cli/index.ts`
    - Parse `process.argv[2]` to select command
    - Dispatch to the appropriate command module
    - Print usage and exit 1 for unknown commands
    - _Requirements: 11.1_

- [x] 15. Checkpoint — full integration wiring
  - Build with `npm run build`. Run `npm test` and ensure all property and unit tests pass. Verify `bin/clipcmd.js` is executable and dispatches correctly. Ask the user if questions arise.

- [x] 16. Phase 2: PTY Wrapper (optional)
  - [x] 16.1 Implement `clipcmd shell` command in `src/cli/commands/shell.ts`
    - Attempt to require `node-pty`; if not installed, print install instructions and exit 1
    - Spawn user's `$SHELL` inside a `node-pty` PTY session, routing I/O through the Daemon capture pipeline
    - Forward SIGWINCH (terminal resize) to the child shell process
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [x] 17. README and package finalization
  - [x] 17.1 Write `README.md`
    - Document: installation via `npx clipcmd init`, `clipcmd start`, `clipcmd stop`, `clipcmd status`, multi-select usage, and Phase 2 PTY mode
    - Include terminal compatibility list: iTerm2, VS Code Terminal, Windows Terminal, GNOME Terminal
    - _Requirements: 11.10_

  - [x] 17.2 Final package verification
    - Run `npm run build` (confirm zero TypeScript errors, `dist/` contains `.js` and `.d.ts` files)
    - Run `npm test` (confirm all tests pass)
    - Run `npm pack --dry-run` and verify only `dist/`, `bin/`, `hooks/`, `README.md` are included
    - _Requirements: 11.2, 11.3, 11.4, 11.5_

- [x] 18. Final checkpoint
  - Ensure all tests pass and `npm run build` succeeds with zero errors. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Checkpoints at tasks 10, 15, and 18 ensure incremental validation
- Property tests use `fast-check` with minimum 100 iterations each
- Unit tests use Vitest
- Shell hooks communicate silently — any network failure must not produce terminal output

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"] },
    { "wave": 2, "tasks": ["2", "3", "4", "6", "7", "8"] },
    { "wave": 3, "tasks": ["5", "9", "11"] },
    { "wave": 4, "tasks": ["10"] },
    { "wave": 5, "tasks": ["12", "13"] },
    { "wave": 6, "tasks": ["14"] },
    { "wave": 7, "tasks": ["15"] },
    { "wave": 8, "tasks": ["16", "17"] },
    { "wave": 9, "tasks": ["18"] }
  ]
}
```
