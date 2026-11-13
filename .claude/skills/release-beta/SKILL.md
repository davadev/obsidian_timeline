---
name: release-beta
description: Cut a prerelease (X.Y.Z-beta.N) of the plugin for BRAT testing. Use whenever a fix or feature has merged to main and needs to be tagged/released, or the user says "release", "tag", "ship a beta", "publish". Every release starts as a prerelease; never create a bare X.Y.Z tag here (use release-stable, and only on explicit go-ahead).
---

# Release a beta

`main`'s `manifest.json` / `package.json` / `versions.json` **do not change**. CI stamps the beta version into the working tree only (`scripts/stamp-prerelease.mjs`, never commit its output). Full manual: `docs/releasing.md`.

**Dependabot gate first.** Before tagging, run the Dependabot gate in `dependency-update`: every open Dependabot PR is folded into this beta (merged or superseded), not left behind.

## Steps
1. Change is merged to `main` via PR with CI green (`feature-done` checklist passed). Wait with `gh pr checks <N> --watch --fail-fast` (never a `sleep` loop). Merge with `gh pr merge <N> --merge` (a merge commit, not squash); add `--admin` only when the owner has said "merge and tag" / authorised bypassing the review requirement. Run merge, tag and issue-close as **separate** commands (a chained one is rejected by permission classifiers). Then `git checkout main && git pull`.
2. Refresh the demo vault copy (`npm run build && cp main.js manifest.json styles.css demo-vault/.obsidian/plugins/timeline-xml-sync/`). If images, screenshots, or generated assets changed: **stop and show the user the result**, get approval before tagging. Docs/asset-only changes still go through this full pipeline.
3. `npm run check-release -- --with-build` must report `0 failed`, `0 warned` and lint with 0 errors AND 0 warnings. Never skip it. Read every yellow `!`. Also `npm run lint:cloud-parity` must report `0 errors` (its type-aware warnings are the scanner's blindness, not defects). A project hook (`.claude/hooks/pre-tag-check.mjs`) runs `check-release --with-lint` before any `git tag <semver>` or tag push and blocks the command on failure; it does not replace the full `--with-build` run.
4. Pick the next number: `git tag --list 'X.Y.Z-beta.*' --sort=-v:refname | head -1`. The `-beta.N` suffix is mandatory; a bare `X.Y.Z` tag auto-promotes to latest stable.
5. `git tag X.Y.Z-beta.N && git push origin X.Y.Z-beta.N`. Never run `gh release create` by hand; `release.yml` does lint/build/test/check-release/attest and publishes the prerelease.
6. Verify: `gh run watch <id> --exit-status` (id from `gh run list --workflow release.yml --limit 1 --json databaseId`), then `gh release view X.Y.Z-beta.N --json tagName,isPrerelease,assets` -> assets are exactly `main.js`, `manifest.json`, `styles.css`, `isPrerelease: true`. Confirm `main`'s manifest still shows the old stable version (`git show origin/main:manifest.json`).
7. If the workflow fails: fix on a branch and tag the **next** number; delete the failed tag (`git push origin :refs/tags/<tag> && git tag -d <tag>`) when you are allowed to (a remote tag delete is often blocked for agents; ask the owner). A leftover tag without a release is harmless. `main` was never touched.
8. Tell the user how to install: BRAT -> Add Beta Plugin -> `davadev/obsidian_timeline`; a new settings group needs a full Obsidian restart to appear.

## Never
- Commit a `-beta.N` version to `main`.
- Hand-upload assets or hand-edit the manifest.
- Mark a bare-tag release as "prerelease" to hide it.
