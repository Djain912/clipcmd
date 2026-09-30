# Releasing

Releases are published by the [Release workflow](.github/workflows/release.yml) when a version tag is pushed. It runs the full test suite first, then publishes.

## First launch: 0.0.1

Both packages are at `0.0.1`, and both names are free: `clipcmd` on npm and `djain912.clipcmd` on the Marketplace (the `djain912` publisher already exists).

1. **Choose the repository's visibility.** The npm package's homepage, bug tracker and repository links point here, so they show a 404 to users while the repository is private. Making it public (**Settings → General → Danger Zone → Change visibility**) fixes that, adds npm provenance, and makes CI minutes free. The extension's "How to Install" button and its README link to the npm page, which works either way.
2. **Add the two secrets** from [One-time setup](#one-time-setup) below. On npm, `clipcmd` does not exist yet, so the token needs write access to *All packages*; allow it to publish without a 2FA prompt. npm write tokens expire, so note the date.
3. **Tag and push:**

   ```bash
   git tag v0.0.1
   git push origin v0.0.1
   ```

4. **Watch the Release workflow** (Actions tab): tests on Linux, macOS and Windows, then npm, the Marketplace, and a GitHub Release with the `.tgz` and `.vsix` attached. If a secret is missing, that step is skipped with a warning; add the secret, delete the tag (`git push origin :v0.0.1`, `git tag -d v0.0.1`) and push it again.
5. **Check the result:** `npm view clipcmd version` prints `0.0.1`; the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=djain912.clipcmd) shows 0.0.1 (verification takes a few minutes).
6. **Try it like a user** on another machine or account: `npm install -g clipcmd`, `clipcmd init`, open a new terminal, run a command, Ctrl+click a button.

## One-time setup

Add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | What | Where to get it |
|---|---|---|
| `NPM_TOKEN` | npm access token that can publish `clipcmd` | npmjs.com → your avatar → **Access Tokens** → **Generate New Token** (granular): **Read and write**, for *All packages* before the first publish (afterwards you can limit it to `clipcmd`), with publishing allowed without 2FA |
| `VSCE_PAT` | Azure DevOps personal access token for the `djain912` publisher | [Create the publisher](https://marketplace.visualstudio.com/manage/createpublisher) `djain912`, then a PAT in Azure DevOps with scope **Marketplace → Manage** and organization **All accessible organizations** |

Without a secret, the matching publish step is skipped and the release still gets its GitHub Release.

## Cutting a release

The CLI and the extension are versioned separately. Tags pick what gets released:

| Tag | Publishes |
|---|---|
| `v1.2.3` | both: the CLI to npm and the extension to the Marketplace (both `package.json` versions must be `1.2.3`) |
| `cli-v1.2.3` | only the CLI |
| `vscode-v1.2.3` | only the extension |

1. Update `version` in `cli/package.json` and/or `vscode-extension/package.json` (and their `package-lock.json`: `npm install --package-lock-only`).
2. Move the `Unreleased` entries in each `CHANGELOG.md` under the new version.
3. Commit, then tag and push:

   ```bash
   git tag v1.2.3
   git push origin main v1.2.3
   ```

4. Watch the Release workflow. It fails without publishing anything if a tag does not match the `package.json` version or a test fails.

While the repository is public, the npm package is published with [provenance](https://docs.npmjs.com/generating-provenance-statements) (npm only supports it for public repositories; from a private one it is published without).

## Manual publishing

```bash
cd cli && npm test && npm publish
cd ../vscode-extension && npm test && npx vsce publish
```
