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
