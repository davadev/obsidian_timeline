# Timeline XML Sync — AGENTS.md

Obsidian plugin: two-way sync between Timeline Project `.timeline` XML and Markdown event notes, plus ` ```timeline ` render blocks. This file holds only what applies to **every** edit. Procedures live in skills (`.claude/skills/`); long rationale in `docs/`.

## Commands

```bash
npm run build               # tsc --noEmit + production esbuild -> main.js
npm run test                # vitest (tests/**/*.test.ts)
npm run test:cov            # vitest + v8 coverage; CI enforces 100 % on all four metrics
npm run lint                # local mirror of Obsidian's auto-review (--max-warnings 0)
npm run lint:css            # stylelint on styles.css (chrome 138 target, no :has)
npm run lint:deps           # package.json: no dependency the review wants replaced
npm run lint:cloud-parity   # the review's type-blind view: must report 0 errors
npm run check:dead-code     # knip --production: unused code (tests do not count as users)
npm run check-release       # release validator, REQUIRED before tagging
                            #   -- --tag X.Y.Z | --with-build | --with-lint | --strict
```

Always `npm run build` (type-check included) before claiming done. Tests alias `obsidian` to `testUtils/obsidian.ts`; helpers live in `testUtils/`, never in `tests/` (only `*.test.ts` there: the review scans anything else).

## Skills: when to use which

Load a skill with the `Skill` tool (or `/<name>`) **before** the work it covers, then follow its checklist. Do not reconstruct the steps from memory.

| Trigger (user words or situation) | Skill |
|---|---|
| About to open/merge a feature or fix PR; adding a setting, command or UI; "is it done?" | `feature-done` |
| Change merged to `main` and needs testing; "release", "tag", "ship a beta", "publish" | `release-beta` |
| User **explicitly** says "promote", "go stable", "release for everyone" | `release-stable` |
| Dependabot PR, `npm install/update`, `package.json`, `.npmrc`, action pins | `dependency-update` |
| After a release; "clean up", stale branches, open issues or PRs | `repo-hygiene` |

Typical flow: `feature-done` (before the PR) -> merge -> `release-beta` -> later, only when told, `release-stable`. When unsure which release skill applies, it is `release-beta`.

## Always-on rules

- Work on a branch (`fix/...`, `feat/...`, `release/X.Y.Z`), PR, CI green, then merge with a merge commit. Never routine work on `main`.
- **Coverage is 100 %.** Unreachable code is **deleted**, never `v8 ignore`d or excluded. Code reachable from persisted/synced/hand-edited data is kept and tested.
- **Zero warnings, zero errors.** `lint`, `lint:css`, `build`, `check:dead-code` and `check-release --strict` are clean before a PR is ready and before any tag. Never silence a rule to get there.
- Lint rules that bite: no static `el.style.x = "literal"` (use a class in `styles.css`), no `console.log` (use `src/logger.ts`), no raw `localStorage` (use `src/obsidian/app-storage.ts`), no `Vault.delete` (use `FileManager.trashFile`), sentence case for UI text. No `!important` in `styles.css`.
- Pure logic under `src/timeline/` never imports Obsidian; only `src/obsidian/` and `src/renderer/` touch the DOM/API. CSS classes are `txs-` prefixed.
- The chart draws only the window on screen: **never touch the DOM while a pinch is live**; assign lanes once across the filtered set, never per tile (`docs/architecture.md`).
- Minimum Obsidian is **1.13.0** (declarative settings); `display()` stays deleted.
- `demo-vault/.obsidian/plugins/timeline-xml-sync/` holds a committed copy of `main.js`, `manifest.json`, `styles.css`; refresh it whenever the build or styles change.
- UI changes are looked at before they ship: render against the real `styles.css`, screenshot headless.
- **Every release starts as a prerelease** (`X.Y.Z-beta.N`, bare SemVer, no `v`). Stable only on explicit instruction. `main`'s `manifest.json` must never advertise a version with no published release.
- Releases are tag-driven (`.github/workflows/release.yml`); never `gh release create` by hand. Manual: `docs/releasing.md`.
- No dependency younger than 14 days (`.npmrc` + Dependabot cooldown); Actions pinned to SHAs; bundled packages pinned exactly. See `dependency-update`.
- **Dependabot gate.** Before every beta and every stable run the Dependabot gate in `dependency-update`: fold every open Dependabot PR into the next beta; stable needs 0 open alerts (turn alerts on if the API says they are disabled).

## Reference

- Release manual (stands alone) -> [`docs/releasing.md`](./docs/releasing.md); store submission -> [`docs/community-plugin-submission.md`](./docs/community-plugin-submission.md)
- Repository: https://github.com/davadev/obsidian_timeline
- Commit convention: `X.Y.Z — short description` for release commits.
