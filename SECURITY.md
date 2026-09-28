# Security Policy

## Supported versions

Security fixes go into the latest release of the `clipcmd` npm package and the `djain912.clipcmd` VS Code extension.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: **Security → Report a vulnerability** on [github.com/Djain912/clipcmd](https://github.com/Djain912/clipcmd/security/advisories/new).

Include what an attacker can do, the steps to reproduce, and the affected versions and platforms. You will get a first answer within a week. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Security model

- The daemon listens on `127.0.0.1` only. It rejects requests that carry browser cross-site markers (`Origin`, or `Sec-Fetch-Site` other than `none`) and requests with an unexpected `Host` header (DNS rebinding), so web pages cannot read or trigger it.
- Anything running as your user on your machine can talk to the daemon; clipcmd does not try to defend against local processes of the same user.
- The `clipcmd://` link handler forwards only the copy and `[+]` actions, with a plain query string, to the daemon registered in the user's config directory.
- Commands and output are kept in the daemon's memory only; nothing is sent over the network.
- The VS Code extension talks only to the local daemon, and runs only the `clipcmd` executable from `PATH` or from the machine-scoped `clipcmd.cliPath` setting, which a workspace cannot override.
