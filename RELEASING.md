# Releasing

Releases are published by the [Release workflow](.github/workflows/release.yml) when a version tag is pushed. It runs the full test suite first, then publishes.

## One-time setup

Add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | What | Where to get it |
|---|---|---|
| `NPM_TOKEN` | npm automation token with publish rights for `clipcmd` | npmjs.com → Access Tokens → Generate New Token → *Granular*, read and write for `clipcmd` (or *Automation* for the first publish) |
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
