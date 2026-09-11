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
| `.github/workflows/ci.yml` | Every push to `main` and every PR: lint → typecheck → build → test → release guard (no tag). |
| `.github/workflows/release.yml` | Fires on a SemVer tag: stamps prereleases, runs the same gate, validates artifacts, attests provenance, publishes. |
| `scripts/stamp-prerelease.mjs` | For suffixed tags only: rewrites version metadata in the **working tree** so assets carry the beta version while the committed manifest stays on the current stable. Nothing is committed. |
| `scripts/check-release.mjs` | The guard. With `--tag`, manifest must equal the tag **exactly** (suffix included). Without one, the committed manifest must be plain `X.Y.Z`. Also checks manifest/package/lock/`versions.json` agreement and that the three assets are non-empty. |
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

More work → merge → `git tag 0.10.0-beta.2 && git push origin 0.10.0-beta.2`.
`main` still never moves.

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

## Pre-promotion checklist

- [ ] Prerelease installed via BRAT and exercised on **desktop and mobile**
- [ ] `main`'s manifest still names the **old** stable version
- [ ] Old stable release still resolves, with all three assets
- [ ] `npm run lint` reports 0 errors
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
