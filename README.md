# Timeline XML Sync

Two-way sync between [Timeline Project](http://thetimelineproj.sourceforge.net/) `.timeline` XML save files and Obsidian Markdown event notes. Renders timeline views in `bar`, `list`, or `hybrid` mode inside any note, including when embedded with `![[note]]`.

**Compatibility:** built and tested against Timeline Project **2.11** save files (`<version>2.11.0</version>`, `<timetype>gregoriantime</timetype>`). The XML parser/writer is defensive — unknown attributes and child elements survive a round-trip — so other Timeline versions should work, but only 2.11 is the verified target.

Mobile-safe — uses only the Obsidian Vault API and browser DOM/SVG. No `fs`, `path`, `electron`, native binaries, or sqlite.

---

## Features

- Imports a `.timeline` XML save file into one Markdown note per event.
- Keeps the XML in sync with valid Markdown event notes (debounced auto-sync).
- BCE / historical dates handled via a custom `TimelineDate` type — no JavaScript `Date` for semantic comparisons.
- ` ```timeline ` fenced render blocks for inline timeline views (`bar`, `list`, `hybrid`).
- Viewport-aware rendering: a note with a `timeline.start` / `timeline.end` acts as a viewport when the timeline is embedded inside it.
- Unknown XML attributes / child elements survive a round-trip.
- Round-trip and validation covered by Vitest.
- Settings UI for paths, mirror property names, render defaults, category colors, backups, and log level.
- Auto-color of imported categories (palette pulled straight from the XML), with per-category color editor in settings.
- Per-device sync toggle (localStorage) — let the desktop own XML writes while the phone stays read-only.
- Crash safety net: a hard crash auto-disables the plugin on next start so Obsidian Mobile keeps loading; a re-enable command clears the flag.
- Performance caches: parsed XML keyed by mtime, event_id → path index served from Obsidian's metadataCache (no per-render YAML reparse).

---

## Install

The plugin ships three files: `manifest.json`, `main.js`, `styles.css`. Drop them into a folder named `timeline-xml-sync` inside your vault's `.obsidian/plugins/` and enable it.

### Desktop (easiest)

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest [release](https://github.com/davadev/obsidian_timeline/releases).
2. In your vault, create the folder `.obsidian/plugins/timeline-xml-sync/` (turn on "Show hidden files" if you can't see `.obsidian`).
3. Move the three files into that folder.
4. Open Obsidian → **Settings → Community plugins** → toggle off **Restricted mode** if needed → click **Reload plugins** → enable **Timeline XML Sync**.

### Mobile (iPhone / iPad / Android)

The plugin is mobile-safe but Obsidian Mobile cannot download release ZIPs directly. Pick whichever route matches your sync setup:

**A. Vault sync that includes `.obsidian/` (Obsidian Sync, Syncthing, iCloud full-vault)**
1. Install on desktop using the steps above.
2. Sync the vault — the plugin folder rides along under `.obsidian/plugins/timeline-xml-sync/`.
3. On the phone, **Settings → Community plugins → Installed plugins** → enable **Timeline XML Sync**.

**B. Vault sync that excludes plugin config (Obsidian Sync with config sharing off, partial sync)**

Two good options, no full-config sync needed:

- **BRAT (recommended)** — install the [Obsidian42 BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from the community catalog (works on iOS), then in BRAT settings **Add beta plugin** with the repo `davadev/obsidian_timeline`. BRAT downloads the latest release assets straight into your phone's vault and keeps the plugin updated. Enable it in Community plugins afterwards.
- **Files app (manual)** — on iOS open the **Files** app → **On My iPhone → Obsidian → \<your vault\>**. If `.obsidian` is hidden, tap the three-dot menu → **Show All**. Create `.obsidian/plugins/timeline-xml-sync/` and drop in `manifest.json`, `main.js`, `styles.css` downloaded from the latest [release](https://github.com/davadev/obsidian_timeline/releases). Restart Obsidian and enable the plugin. Same path works on Android via any file manager.

**C. Quick one-shot transfer**
- **AirDrop / Quick Share** the three release files from a desktop into the Obsidian vault folder using the Files app.
- **a-Shell** (free iOS terminal) can `curl` the release assets and `mv` them under `.obsidian/plugins/…`.

> The plugin uses only the Obsidian Vault API and browser DOM/SVG — no Node, no Electron, no native modules — so it works on iOS the same way it does on desktop.

### From source

```bash
git clone https://github.com/davadev/obsidian_timeline.git
cd obsidian_timeline
npm install
npm run build
# copy manifest.json, main.js, styles.css into your vault as above
```

For development with live rebuild:
```bash
npm run dev
```

---

## Configuration

Open **Settings → Timeline XML Sync** and set at minimum:

| Setting | Default | Purpose |
| --- | --- | --- |
| XML save file path | `timelines/main.timeline` | Vault-relative path to the `.timeline` file. |
| Event notes directory | `Timeline events` | Folder where one MD note per event lives. |
| Templates directory | `Templates` | Where the plugin writes its event template. |
| Timeline id | `main` | Stored as `timeline.id` in every event note. |
| Mirror property names | `timeline_start`, `timeline_end`, … | Top-level frontmatter keys for Dataview-style usability. |
| Render defaults | `mode: hybrid`, `details: list`, `sort: chronological`, fields = `title,date,category,description` | Default options for ` ```timeline ` blocks. |
| Category colors | _(empty)_ | CSS color per category (e.g. `Prophecies` → `#88b`). |
| Backup XML before overwriting | on | Saves `.timeline.bak-<timestamp>` next to the source. |
| Auto-sync | on, 1500 ms debounce | Markdown changes regenerate XML automatically. |

---

## Markdown schema

Every event note has normal Obsidian YAML frontmatter. The nested `timeline:` object is the **source of truth**; the top-level `timeline_*` keys are mirrors for Dataview compatibility only.

```yaml
---
title: 70 weeks of years
tags:
  - Timeline
  - Spiritual

timeline:
  enabled: true
  id: main
  event_id: seventy-weeks
  role: event
  source_xml: timelines/main.timeline
  category: Prophecies
  render: true
  ends_today: false
  hyperlink: null
  start:
    year: -454
    month: 3
    day: 30
    hour: 0
    minute: 0
    second: 0
  end:
    year: 36
    month: 7
    day: 30
    hour: 0
    minute: 0
    second: 0

timeline_start: "-0454-03-30"
timeline_end: "0036-07-30"
timeline_category: Prophecies
timeline_event_id: seventy-weeks
timeline_render: true
timeline_role: event
---

# 70 weeks of years

## Text
70 weeks of years

## Description
Description text. Obsidian links like [[Some Note]] are preserved.
```

Notes:

- `timeline.start.year` and `timeline.end.year` may be any integer (negative = BCE). The plugin never funnels these through a JavaScript `Date`.
- `timeline.role: event` is required for sync. Use `timeline.role: viewport` (or omit entirely) for "scope" notes that only define a window for embedded renders.
- Sections `## Text` and `## Description` are read back as text/description on the next sync.

---

## Render block

In any note:

````markdown
```timeline
mode: hybrid
source: main
details: list
sort: chronological
show:
  - title
  - date
  - category
  - description
  - tags
  - links
categories:
  include: []
  exclude: []
```
````

Options:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `mode` | `bar` / `list` / `hybrid` | `hybrid` | Visual + textual. |
| `source` | string | `main` | Logical id (matches `timeline.id`). |
| `sourceXml` | string | _(settings)_ | Override XML path for this block. |
| `details` | `list` / `compact` / `table` / `cards` | `list` | At least `list` and `compact` are implemented. |
| `sort` | `chronological` / `reverse-chronological` / `category` | `chronological` | |
| `show` | list | `[title,date,category,description]` | Fields rendered next to each event in the textual view. |
| `categories.include` / `.exclude` | list | _(empty)_ | Category name filter. |

### Viewport

If the current note (or the note that embeds the block via `![[note]]`) has a `timeline.start` / `timeline.end`, that range is used as the viewport. Events overlapping the viewport are shown:

- range overlaps if `event.start ≤ viewport.end` **and** `event.end ≥ viewport.start`
- point overlaps if `viewport.start ≤ point ≤ viewport.end`

If no viewport is defined, the displayed period from the XML `<view>` is used. Otherwise all events are shown.

---

## Commands

| Command | Effect |
| --- | --- |
| Timeline XML Sync: Import XML to Markdown event notes | First import or re-import (overwrites existing notes per id). |
| Timeline XML Sync: Validate all timeline event notes | Surfaces validation errors in the Diagnostics section / console. |
| Timeline XML Sync: Regenerate XML from Markdown | Refuses to write if any event note is invalid. |
| Timeline XML Sync: Create/Update event note template | Writes the plugin template to the configured templates folder. |
| Timeline XML Sync: Create new timeline event note | Creates a fresh event note even without the core Templates plugin. |
| Timeline XML Sync: Open timeline sync diagnostics | Dumps current diagnostics to the developer console. |
| Timeline XML Sync: Rebuild internal index/cache | Forces a fresh validate/index. |

Auto-sync is enabled by default — any MD change inside the event notes directory triggers a debounced regenerate.

---

## XML compatibility notes

The Timeline Project XML format is parsed defensively:

- Unknown event/category child elements are preserved verbatim and re-emitted unchanged when the event is round-tripped.
- Event ordering is preserved.
- Categories not referenced by any event are kept.
- New categories introduced by Markdown notes are appended with a neutral `200,200,200` color — adjust in Timeline Project or via Markdown.
- The `<view>` block (displayed period, hidden categories) is preserved.

**Untested / TODO** — confirm against your real save file once you drop it in:

- Container/sub-event nesting (some Timeline versions emit nested `<event>` for milestones).
- `progress`, `alert`, `icon`, `default_color` fields — written when present, but the exact wire format from Timeline 2.11 should be cross-checked.
- Time-type values other than `gregoriantime`.

---

## Testing

```bash
npm test
```

Covered by Vitest:

- BCE/CE date parsing and ordering.
- Range vs. point overlap and lane assignment.
- Validator: invalid dates, start > end, duplicate ids, BCE leap-year edge cases.
- XML → MD → XML round-trip on the bundled synthetic fixture (`tests/fixtures/sample.timeline`).
- Unknown XML element preservation.
- Adding a new event from Markdown produces a valid XML that contains it.
- Invalid markdown is detected before XML write.

Round-trip is asserted as **canonical** equality (parse → strip whitespace text nodes → re-emit) because XML byte-for-byte equality is incompatible with stable formatting.

---

## Project layout

```
src/
  main.ts
  settings.ts
  settings-tab.ts
  obsidian/
    vault-adapter.ts          # all file IO goes through Vault
    commands.ts                # Obsidian command wiring + import/regenerate
    markdown-postprocessor.ts # ```timeline block renderer entry point
    template-service.ts        # template + "create new event" command
  timeline/
    model.ts                   # canonical in-memory model
    date.ts                    # TimelineDate, BCE-safe ordering
    xml-parser.ts              # fast-xml-parser preserveOrder
    xml-writer.ts              # writes back, preserves unknown nodes
    markdown-parser.ts         # frontmatter + body → event
    markdown-writer.ts         # event → markdown with mirror props
    validator.ts               # date sanity + duplicate id detection
    sync-engine.ts             # mergeNotesIntoDoc + debounce
    overlap.ts                 # viewport filter + lane assignment
    id-utils.ts                # slugify + uniqueSlug
  renderer/
    render-options.ts          # default + per-block options shape
    bar-renderer.ts            # SVG bar + tooltip/mobile panel
    list-renderer.ts           # chronological text list
    tooltip.ts                 # desktop tooltip
    index.ts                   # renderTimeline dispatch
tests/
  fixtures/sample.timeline     # synthetic public fixture (no user data)
  date.test.ts
  overlap.test.ts
  validator.test.ts
  xml-roundtrip.test.ts
  markdown-sync.test.ts
```

---

## Privacy

The example file path `./Timeline2_11.timeline` (your personal save) is in `.gitignore` and never read by tests or shipped fixtures. Tests use the synthetic `tests/fixtures/sample.timeline` only.

---

## License

MIT.
