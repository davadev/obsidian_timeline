# Architecture

## Project layout

```
src/
  main.ts                          # plugin entry: lifecycle, ribbon, vault events
  settings.ts                      # TimelineXmlSyncSettings + defaults
  settings-tab.ts                  # settings UI
  obsidian/
    vault-adapter.ts               # thin Vault API wrapper (only file IO entry point)
    commands.ts                    # import / regenerate / wipe-reimport / auto-detect / new event
    sync-policy.ts                 # pure helpers: shouldSkipNoteOverwrite, shouldAbortXmlWrite
    cache.ts                       # XML cache (mtime-keyed) + MD doc cache + render overlay
    markdown-postprocessor.ts      # ```timeline block renderer entry point + viewport resolver
    template-service.ts            # "new event" / "new era" interactive flows
    timeline-view.ts               # workspace-leaf global view
    inspector-view.ts              # right-sidebar Inspector (edit events + eras)
    export.ts                      # export note: render timelines to PNG attachments
    device-prefs.ts                # per-device sync toggle (localStorage)
  timeline/
    model.ts                       # canonical in-memory model
    date.ts                        # TimelineDate, BCE-safe ordering, Julian day for layout
    xml-parser.ts                  # fast-xml-parser preserveOrder + manual entity decode
    xml-writer.ts                  # writes back; preserves unknown nodes verbatim
    markdown-parser.ts             # frontmatter + body → event
    markdown-writer.ts             # event → markdown with mirror props + stamp
    era-md.ts                      # era note render + parse
    era-utils.ts                   # pure helpers: filterErasToViewport, autoViewportFromEvents
    validator.ts                   # date sanity + duplicate id detection
    sync-engine.ts                 # mergeNotesIntoDoc + debounce
    overlap.ts                     # viewport filter + lane assignment
    id-utils.ts                    # slugify + uniqueSlug
    base64.ts                      # browser-safe base64 (btoa/atob) + image-format sniff
  renderer/
    render-options.ts              # default + per-block options shape
    bar-renderer.ts                # SVG bar + tooltip + mobile panel
    list-renderer.ts               # chronological text list
    tooltip.ts                     # desktop hover tooltip
    filter-bar.ts                  # rich filter panel + applyRichFilter
    index.ts                       # renderTimeline dispatch (viewport precedence, era filtering)
tests/
  fixtures/sample.timeline         # synthetic public fixture (no user data)
  date.test.ts
  overlap.test.ts
  validator.test.ts
  xml-roundtrip.test.ts
  markdown-sync.test.ts
  filter.test.ts
  sync-conflict.test.ts            # 0.8.0 hardening: skip/CAS/stamp roundtrip
  era-utils.test.ts                # 0.8.1 pure era helpers
  renderer-display.test.ts         # 0.8.2 jsdom regression suite
  setup-obsidian-dom.ts            # polyfill for Obsidian-specific DOM helpers
demo-vault/
  Welcome.md                       # vault entry point
  Tour - *.md                      # showcase notes
  timelines/Rome.timeline          # public-domain Rome timeline
```

## Layering

Three rings, inner depends on nothing in outer:

1. **`src/timeline/`** — pure logic. No Obsidian API, no DOM. Tested directly under vitest's `node` env.
2. **`src/renderer/`** — DOM-only. Uses `document` + SVG. Tested under jsdom with a thin Obsidian-DOM polyfill.
3. **`src/obsidian/`** — Obsidian integration. Vault IO, views, settings, commands. Not unit-tested; behaviour exercised through the demo vault.

`src/main.ts` wires them together.

## Caches

- **XML doc** keyed by `TFile.stat.mtime`. Reparse only when mtime changes.
- **MD doc** rebuilt from the event notes directory. 30-second TTL plus `metadataCache.on("changed")` invalidation.
- **Render doc** = `overlayMdOnXml(xml, md)` — MD events override XML events by id; MD-only events appended; categories union-merged.
- **id → path index** built from `metadataCache.frontmatter` — no per-render YAML reparse.

## Multi-device safety primitives

- `last_synced_xml_mtime` stamp on every plugin-written event/era MD note — used to skip overwrite on `importXml` when the file is locally newer.
- `lastWrittenXmlMtime` setting — used to detect external XML changes (`shouldAbortXmlWrite` CAS guard on regenerate, plus a 30-second interval watch that fires a one-shot Notice).
- Per-path self-write Map with 5-second TTL — replaces a single 300ms `__SELF__` flag that was too short for remote-sync landing latency.
- Append-only `_logs/timeline-sync.log` rotated at ~200KB.

## Testing

```bash
npm test               # vitest run
npm run test:watch     # watch mode
npm run typecheck      # tsc -noEmit
npm run build          # production esbuild
npm run lint           # eslint-plugin-obsidianmd, review severities, zero-warning gate
npm run check-release  # version/asset guard (see docs/releasing.md)
```

The release workflow runs exactly this set plus artifact validation before it
publishes anything — see [releasing.md](./releasing.md).

Test environment is `node` by default; `tests/renderer-display.test.ts` opts into `jsdom` via `// @vitest-environment jsdom`.
