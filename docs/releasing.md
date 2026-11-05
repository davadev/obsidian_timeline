# Releasing

Tag-driven, gated releases. **Nobody runs `gh release create` by hand** — pushing a
SemVer tag is the only way anything is published.

## The one invariant

> `manifest.json` on `main` must always name a version that has a published
> GitHub release with valid assets.

Obsidian reads `manifest.json` **on the default branch** to learn the latest
version, then downloads assets from the release tagged **exactly** that version.
BRAT ignores the repo root entirely and reads `manifest.json` / `main.js` /
`styles.css` **from the release assets**, picking the highest semver including
prereleases.

Consequences:

- Never commit `X.Y.Z-beta.N` to `main`'s `manifest.json`.
- Never bump `main` to the next stable version until that stable release exists.
- GitHub's "prerelease" flag is **not** isolation — Obsidian never reads it. A
  bare `X.Y.Z` tag flagged prerelease still becomes the advertised release.

## Pieces

| File | Role |
|---|---|
| `.github/workflows/ci.yml` | Every push to `main` and every PR: lint, stylelint, dependency lint, typecheck, build, tests at 100 % coverage, dead-code check, release guard (`--strict`, no tag), the review's type-blind lint. A separate `store-listing` job checks `main` never advertises a version without a published release. Make `check` and `store-listing` required status checks. |
| `.github/workflows/release.yml` | Fires on a SemVer tag: checks the tag is on `main` (stable: or a `release/*` branch), stamps prereleases, runs the same gate, validates artifacts, attests provenance, publishes. Serialised by a static concurrency group. |
| `.github/dependabot.yml`, `.npmrc` | Supply-chain policy, see below. `check-release` fails if either loses its 14-day age setting. |
| `scripts/check-store-listing.mjs` | CI job `store-listing`: when `manifest.version` changes it needs a published, non-prerelease release with all three assets and a `versions.json` entry. Red on the stable release PR until the tag has published; re-run after. |
| `scripts/lib/*.mjs` | The guard's pure predicates (`releaseChecks`, `supplyChainChecks`), unit-tested. |
| `scripts/stamp-prerelease.mjs` | For suffixed tags only: rewrites version metadata in the **working tree** so assets carry the beta version while the committed manifest stays on the current stable. Nothing is committed. |
| `scripts/check-release.mjs` | The guard. With `--tag`, manifest must equal the tag **exactly** (suffix included). Without one, the committed manifest must be plain `X.Y.Z`. Also checks manifest/package/lock/`versions.json` agreement, the community-store manifest rules (see `docs/community-plugin-submission.md`), mobile-safe imports, that the three assets are non-empty, that `release.yml` still attests them, and the supply-chain policy. `--strict` turns warnings into failures (the release workflow uses it). |
| `eslint.config.mjs` | `eslint-plugin-obsidianmd` at the severities used by the community-plugin review. `npm run lint` runs with `--max-warnings 0`, so a release is blocked by any error **or** warning. |

Tags are **bare** — `0.10.0`, not `v0.10.0`. (Tags up to `v0.8.11` predate this
and are left alone.) The guard rejects a `v` prefix.

## The cycle

### 1. Develop

Branch → PR → CI green → merge. **No version files change.** `main` keeps
advertising the current stable version for the whole feature.

### 2. Cut a prerelease

`X.Y.Z` is the *next* stable version, `N` starts at 1:

```bash
git checkout main && git pull
git tag 0.10.0-beta.1
git push origin 0.10.0-beta.1
```

Committed to `main`: **nothing**. The workflow stamps `0.10.0-beta.1` into the
assets and publishes a GitHub prerelease.

The release workflow refuses a prerelease tag whose commit is not on `main`
(and a stable tag not on `main` or a `release/*` branch): releases come from
reviewed code. Merge the PR first, **then** tag `main`. The invariant still
holds because `main`'s manifest never moves for a beta.

Before tagging, rebuild and refresh the committed demo-vault copy, so the
plugin bundled in `demo-vault/` matches what ships:

```bash
npm run build
cp main.js manifest.json styles.css demo-vault/.obsidian/plugins/timeline-xml-sync/
```

### 3. Test it

BRAT → *Add Beta Plugin* → `davadev/obsidian_timeline`. BRAT picks the highest
semver including prereleases; its frozen-version option pins a tester to one
exact tag. Exercise it on **desktop and mobile** — the plugin is not
desktop-only.

Confirm ordinary users are unaffected:

```bash
git show main:manifest.json | grep version           # -> old stable
gh release view 0.9.3 --json tagName,assets          # -> exists, 3 assets
gh release view 0.10.0-beta.1 --json isPrerelease    # -> true
```

### 4. Iterate

More work → commit → `git tag 0.10.0-beta.3 && git push origin 0.10.0-beta.3`.
`main` still never moves. Bump the suffix every time; a tag is never moved or
reused once pushed.

Watch the run and confirm the result rather than assuming:

```bash
gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh release view 0.10.0-beta.3 --json tagName,isPrerelease,assets
curl -sL https://github.com/davadev/obsidian_timeline/releases/download/0.10.0-beta.3/manifest.json
```

### 5. Promote to stable

**Publish the release before `main` advertises it.** That makes the dangerous
window zero rather than "a few minutes".

```bash
git checkout -b release/0.10.0 main
npm version 0.10.0 --no-git-tag-version   # manifest + versions.json + lock
npm run check-release -- --tag 0.10.0
git commit -am "0.10.0 — release"
git push -u origin release/0.10.0
gh pr create --fill                        # CI runs

# 1. tag the RELEASE BRANCH head -> the workflow publishes the stable release
git tag 0.10.0 && git push origin 0.10.0

# 2. verify it is real before anyone is pointed at it
gh release view 0.10.0 --json tagName,isDraft,isPrerelease,assets

# 3. only now let the default branch advertise it
gh pr merge --merge        # --merge, NOT --squash: keeps the tagged commit reachable
```

`npm version` runs `version-bump.mjs`, which writes `manifest.json` and adds the
`versions.json` entry mapped to the current `minAppVersion`.

If the workflow fails, delete the tag, fix on the branch, retag — `main` was
never touched:

```bash
git push origin :0.10.0 && git tag -d 0.10.0
```

## Gate

All of these must pass before a tag; CI runs them on every PR and the release
workflow runs them again on a clean runner:

```bash
npm run lint && npm run lint:css && npm run lint:deps && npm run typecheck \
  && npm run build && npm run test:cov && npm run check:dead-code \
  && npm run check-release -- --strict && npm run lint:cloud-parity
```

`test:cov` fails under 100 % on statements, branches, functions and lines.
Unreachable code is deleted, never ignored (`tests/coverage-gate.test.ts` pins
this). `lint:cloud-parity` renames `node_modules/obsidian` while it runs; if a
run is ever killed, `npm ci` repairs it.

## Supply chain

- **Actions are pinned to full commit SHAs** with the readable version in a
  trailing comment; Dependabot updates both. Re-resolve by hand with
  `gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha` (deref
  annotated tags via `git/tags/<sha>`). Checkouts use
  `persist-credentials: false`; permissions are job-scoped.
- **14-day dependency age**: `min-release-age=14` in `.npmrc` (needs npm >= 11.10;
  `npm ci` ignores it, it guards hand-run `npm install/update`) and a 14-day
  `cooldown` in `dependabot.yml` for both ecosystems (30 for npm majors).
  Never pass `--min-release-age=0`; an urgent exception goes in
  `min-release-age-exclude[]` in the PR that needs it.
- **Install scripts denied**: `allowScripts` in `package.json` approves nothing.
- **No runtime `dependencies`**: esbuild bundles everything, so everything is a
  devDependency. `npm ls --all` must exit 0 (`npm ci` does not notice).
- **Dependabot is PR-only.** Groups: `vitest` + `@vitest/*` together (coverage
  peer-pins vitest exactly), other minor/patch together, majors alone. Ignores
  live only in `dependabot.yml`; never reply `@dependabot ignore` on a PR.
- A Dependabot PR is visibility, not an obligation. Tag a beta only if
  `main.js` would change.

## Pre-promotion checklist

- [ ] Prerelease installed via BRAT and exercised on **desktop and mobile**
- [ ] `main`'s manifest still names the **old** stable version
- [ ] Old stable release still resolves, with all three assets
- [ ] `npm run lint` reports 0 errors and 0 warnings
- [ ] `npm run build` and `npm test` pass
- [ ] `npm run check-release -- --tag <version>` passes
- [ ] `manifest.json`, `package.json`, `package-lock.json`, `versions.json` agree
- [ ] New version in `versions.json`, mapped to its `minAppVersion`
- [ ] Stable release published **and verified** *before* merging the release PR

## What not to do

- ❌ Commit a `-beta.N` version to `main`'s manifest.
- ❌ Bump `main` ahead of the release. *The* failure mode.
- ❌ Create the bare `X.Y.Z` tag early and just flag it prerelease.
- ❌ Strip `-beta.N` before comparing tag to manifest.
- ❌ Squash-merge the release PR.
- ❌ Hand-upload assets — publish only through the tag-triggered workflow, so
  what ships is always the validated, attested build.

## Bumping `minAppVersion`

`eslint-plugin-obsidianmd` errors when the code calls an API newer than
`manifest.minAppVersion`. If you raise it, raise it in `manifest.json` **and**
the current release's entry in `versions.json` during the release bump.

The floor is currently **1.13.0**: the settings tab is built on the declarative
settings API (`getSettingDefinitions()`), which also means `display()` must stay
deleted — implementing both trips `obsidianmd/settings-tab/no-deprecated-display`.
