---
name: release-stable
description: Promote a tested beta to stable X.Y.Z. ONLY on the user's explicit go-ahead. Use when the user says "promote", "go stable", "publish stable", "release X.Y.Z for everyone". Covers release branch, version bump, tagging the branch head before merge, and issue cleanup.
---

# Promote to stable

Only run after the user explicitly says so. The stable release must be **published before `main` advertises it**.

**Alert gate.** Run the Dependabot gate in `dependency-update` before tagging: **0 open alerts**, or the user has been told which remain and why. Dependabot PRs that opened after the tested beta go into the next beta, not into this stable.

## Steps
1. `git checkout -b release/X.Y.Z main`.
2. Bump `manifest.json`, `package.json`, `versions.json` (`"X.Y.Z": "1.13.0"`) to `X.Y.Z`; `npm install --package-lock-only` (else CI's version-skew check fails).
3. Docs reflect the release (`docs/`, README) and the demo vault copy is refreshed.
4. `npm run check-release -- --tag X.Y.Z --with-build --strict` -> 0 failed, 0 warned, lint 0 errors AND 0 warnings.
5. Commit `X.Y.Z — short description`, push, open the PR, wait for CI green.
6. Tag the **release branch head**: `git tag X.Y.Z && git push origin X.Y.Z`. Let `release.yml` publish.
7. Verify: `gh release view X.Y.Z --json tagName,isLatest,assets` -> latest, three assets (`main.js`, `manifest.json`, `styles.css`). Paste the notes into the release.
8. Only now merge: `gh pr merge <n> --merge --delete-branch`. Use `--merge`, **not** `--squash`, so the tagged commit stays reachable from `main`.
9. Cleanup: close the issues the release resolves, update the tracker/roadmap, `git checkout main && git pull`.
10. If the workflow fails: delete the tag (`git push origin :X.Y.Z && git tag -d X.Y.Z`), fix on the branch, retag. `main` was never touched.

## Never
- Create the bare tag early and flag it prerelease.
- Bump `main` to a version with no published release.
