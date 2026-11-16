---
name: dependency-update
description: Rules for bumping npm dependencies, GitHub Actions, or the bundler in this repo. Use when reviewing Dependabot PRs, running npm install/update, or touching package.json, package-lock.json, .npmrc, dependabot.yml or workflow action pins.
---

# Dependency updates

- **Age** (house choice: one maintainer's supply-chain policy; keep it or set your own number, but keep a cooldown): never adopt a version younger than 14 days (`.npmrc` `min-release-age=14`, Dependabot `cooldown:`; check-release fails if either disappears). Urgent non-security exception -> `min-release-age-exclude[]` in the same PR. Security updates are not delayed.
- **Pinned EXACT, matching `obsidian`'s peers**: `@codemirror/state` and `@codemirror/view` (see `node_modules/obsidian/package.json` `peerDependencies`). A mismatch breaks `npm ci` with `ERESOLVE`. They move only when the `obsidian` devDependency moves; Dependabot-ignored.
- **Bundled into `main.js`**: anything not in esbuild's `external` list ships. Here that is `fast-xml-parser`, `fast-xml-builder` and `yaml` (exact devDependencies); `obsidian` and `@codemirror/*` are external. Pin it exactly (and pin its transitive editor/parser packages via `overrides`). After any `npm install`, confirm the pins held; the build output hash is the real check. Reachability cannot be judged by grepping `src/`: a library may bind behaviour (keymaps, listeners) on its own.
- **esbuild** moves only on a release of its own; never entangled with other changes (its output is the shipped `main.js`).
- **eslint** is NOT Dependabot-ignored. For a major: confirm the rule count does not shrink (`npx eslint --print-config src/main.ts`) and stderr is empty (0 findings also happens when a plugin fails to load).
- **`npm ls --all` must exit 0** (check-release fails otherwise); `npm ci` succeeds even on an inconsistent tree.
- **No runtime `dependencies`** unless unavoidable; `npm audit --omit=dev` must stay clean. Dev advisories are informational and never block a release. `allowScripts` must approve no package.
- **GitHub Actions pinned to commit SHAs** with a `# vX.Y.Z` comment; bump within the current major (`gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha`, deref annotated tags); majors come as separate Dependabot PRs.
- Chase version constraints transitively (engines of deps, the npm shipped with each Node); defer high-risk, low-value bumps to Dependabot.
- After any dependency change: `npm ci && npm run lint && npm run build && npm test && npm run check-release -- --with-build`.
- **Several Dependabot PRs open, or one cannot pass CI?** Bundle them yourself in one branch, applied sequentially (never check out each bot branch in turn: later checkouts overwrite earlier bumps). Peer families move together: `vitest` + `@vitest/coverage-v8`; `obsidian` + `@codemirror/state` + `@codemirror/view` (re-pin to the new peers). Majors one at a time. PR body `Supersedes #a, #b`; close the bot PRs with `gh pr close <n> --comment "Applied in #<bundle>"`. Full procedure: playbook `SUPPLY-CHAIN.md` §6.1.
- **Portable edits**: `perl -pi -e`, never `sed -i` (macOS and Linux differ and a failure breaks an `&&` chain).
- **After a major**: coverage dip → read the uncovered line (reachable from persisted data → test by faking the boundary; else delete); an `@types/*` package made redundant → remove it (knip). After a Playwright bump: `npx playwright install chromium webkit`.
- **Beta or not?** Compare `sha256sum main.js` before and after. Unchanged bytes (test runner, linter, Action pins) → merge without a tag and say so in the PR. This is the only exception to "docs/asset-only changes still go through the release pipeline" (`release-beta` step 2): there, users receive different files; here they receive identical ones.
- **Maintainable, not cutting edge**: stay on the versions that shipped; take patch/minor updates of your current line (advisories first); adopt a new major deliberately, one at a time, after it has settled; one major behind is fine while supported. Before adding any package: is it maintained, browser/mobile-safe, typed, install-script-free, widely used? Prefer no dependency. Playbook `SUPPLY-CHAIN.md` §3.1.

## Dependabot gate (before every beta, before every stable)

1. **Open PRs.** `gh pr list --state open --author "app/dependabot"`. Fold every one into the next beta: merge it, or supersede it with your own branch (a conflicting or failing grouped PR is redone on a fresh branch and closed with a pointer), and only then tag. Never tag a beta around an open Dependabot PR. A PR that opens after a beta was tested goes into the following beta, not into the stable that promotes the tested one.
2. **Alerts.** `gh api repos/<owner>/<repo>/dependabot/alerts --jq '[.[]|select(.state=="open")]|length'`. HTTP 403 "Dependabot alerts are disabled" means they are off: turn them on with `gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts` (repo admin; a GET of the same path answering 204 means on), then re-read in a few minutes. Optionally `gh api -X PUT repos/<owner>/<repo>/automated-security-fixes`. Guide: playbook `SUPPLY-CHAIN.md`, "Turning on Dependabot alerts".
3. **Fix, do not dismiss.** Lockfile first (`npm update <pkg>`, exact bump for a direct dependency), then parent-scoped `overrides`, then a clean `rm -rf node_modules && npm ci && npm ls --all && npm audit`. Never dismiss an alert to get green.
4. **Stable needs 0 open alerts.** If one cannot be fixed (no patch yet, a parent breaks under the override), tell the user which and why before tagging stable; the user decides.

## Auto-merge lane (no human needed for the boring ones)

Dependabot PRs merge themselves when every one of these holds (rules: `scripts/lib/automergePolicy.mjs`, knobs: `.github/automerge.json`):
- author `dependabot[bot]`, branch in this repo, only `package.json` + `package-lock.json` changed, and only dependency versions (and plain-semver `overrides`) moved;
- every changed lockfile entry is from `registry.npmjs.org` with a sha512 integrity, no install script, same major (0.x minors count as majors), nothing on the denylist (`esbuild`, `@codemirror/*`, `obsidian`, `typescript`, `@types/node`);
- the new versions are old enough: critical advisory 0 days, other security fix 3 days, routine bump 14 days;
- `validate` is green on the exact head commit, `main` has not moved since the build, and `sha256(main.js)` built from the PR equals the one built from `main` (`shipped-bytes` CI job; the build must also be reproducible).

Outcomes, always commented on the PR: **merge** (pinned with `--match-head-commit`, then CI is dispatched on `main` because a `GITHUB_TOKEN` merge starts no push workflow), **skip** (a human looks; the reasons are in the comment), **needs-beta** (security fix that changes shipped bytes: PR labelled, issue opened, never merged: cut a beta with `release-beta`).

- `"dryRun": true` in `.github/automerge.json` comments the verdict and never merges. Flip it only after the verdicts of 2-3 real Dependabot PRs looked right.
- Red CI on `main` after an auto-merge opens an `automerge-broke-main` issue and pauses the lane. Revert or fix forward, then close the issue.
- Never widen the lane to workflow files, `scripts`, or `src/`: a bot that may edit the code that approves it approves itself. Majors, Actions pins, `esbuild`, `@codemirror/*`, `obsidian` stay manual on purpose.
- The weekly `Dependency sweep` issue (`deps-sweep.yml`) is the one list of what is stuck; read it instead of the PR tab.
