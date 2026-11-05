# Submitting to the Obsidian community plugin directory

Short checklist, kept in the repo so a cold session can find it. The guard
(`npm run check-release -- --strict`) enforces most of it.

- `manifest.json` has non-empty `id`, `name`, `version`, `minAppVersion`,
  `description`, `author` and a boolean `isDesktopOnly`. The id is lowercase
  letters and hyphens, contains no "obsidian" and does not end in "plugin"; the
  name has no "Obsidian" or "Plugin"; the description is at most 250
  characters, ends with a period and has no emoji.
- `manifest.json`, `package.json`, both versions in `package-lock.json` and
  `versions.json` agree. `minAppVersion` is **1.13.0** (declarative settings
  API); say so in the submission, as it limits who can install.
- The tag equals `manifest.version` exactly, with no `v` prefix. The release
  carries `main.js`, `manifest.json` and `styles.css`, published by the
  tag-driven workflow, never by hand.
- Publish the matching **stable** GitHub release *before* opening the
  submission pull request against `obsidianmd/obsidian-releases`, and never let
  `main` advertise a version without one (the `store-listing` CI job).
- `README.md` and `LICENSE` exist. No secrets, no hardcoded user paths, no
  Node-only imports (the plugin runs on mobile).
- `npm run lint` is clean at zero warnings, and `npm run lint:cloud-parity`
  (the review's type-blind view) reports no errors. Test helpers live in
  `testUtils/`, tests in `tests/*.test.ts`, so the review does not scan them.
- On review feedback: bump the version, publish a new matching release. No
  resubmission is needed; the directory rescans on a new release.
