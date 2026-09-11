# Timeline XML Sync — working notes

Obsidian plugin. Two-way sync between Timeline Project `.timeline` XML and
Markdown event notes, plus ` ```timeline ` render blocks.

## Before doing release work

**Read [docs/releasing.md](docs/releasing.md) and follow it.** Do not invent a
different release flow. The one invariant:

> `manifest.json` on `main` must always name a version that has a published
> GitHub release with valid assets.

Releases are tag-driven — pushing a SemVer tag is the only way anything is
published. Never `gh release create` by hand, never hand-upload assets.

## Gate

`npm run lint` (eslint-plugin-obsidianmd at community-review severities,
`--max-warnings 0`), `npm run typecheck`, `npm run build`, `npm test`,
`npm run check-release`. CI runs all of it on PRs; the release workflow runs it
again on a clean runner before publishing. All five must pass locally before
you push a tag.

Lint rules that bite: no static `el.style.x = "literal"` (use a class in
`styles.css`), no `console.log` (use `src/logger.ts`), no raw `localStorage`
(use `src/obsidian/app-storage.ts`), no `Vault.delete` (use
`FileManager.trashFile`), sentence case for UI text (the rule's brand/acronym
exceptions live in `eslint.config.mjs`).

## The chart, in one paragraph

The Timeline view draws only the time window on screen: an empty spacer gives
the scroller its range and a ring of pane-wide tiles is positioned inside it
(`src/renderer/windowed-chart.ts`, maths in `time-window.ts`). Two rules break
it if ignored — **never touch the DOM while a pinch is live** (the browser
cancels a gesture whose target is removed; a live gesture only sets CSS custom
properties), and **assign lanes once across the filtered set**, never per tile.
Full detail in [docs/architecture.md](docs/architecture.md#the-windowed-chart-011).

## Conventions

- Minimum Obsidian version is **1.13.0**: the settings tab uses the declarative
  settings API (`getSettingDefinitions()`), and `display()` must stay deleted —
  having both trips `obsidianmd/settings-tab/no-deprecated-display`.
- Tags are bare SemVer (`0.10.0`), never `v`-prefixed. Tags up to `v0.8.11`
  predate this and are left alone.
- CSS classes are `txs-`-prefixed and live in `styles.css`.
- `demo-vault/.obsidian/plugins/timeline-xml-sync/` holds a committed copy of
  `main.js`, `manifest.json` and `styles.css` so the demo vault is turnkey.
  Refresh it (`cp main.js manifest.json styles.css demo-vault/...`) whenever you
  change the build or the styles.
- Pure logic under `src/timeline/` never imports Obsidian; only
  `src/obsidian/` and `src/renderer/` touch the DOM/API. Chart maths
  (`time-window.ts`, `axis-ticks.ts`, `zoom-math.ts`) is DOM-free and tested
  directly.
- UI changes get looked at before they ship: bundle the module with esbuild,
  render it in a fixture page against the real `styles.css`, screenshot it
  headless. Green tests are not evidence that something is on screen.

## Docs

`docs/` covers install, settings, the render block, the Markdown schema, XML
compatibility, multi-device sync safety, architecture, and releasing.
