# Settings reference

Open **Settings → Timeline XML Sync**.

## Paths

| Setting | Default | Purpose |
| --- | --- | --- |
| XML save file path | `timelines/main.timeline` | Vault-relative path to the `.timeline` file. |
| Event notes directory | `Timeline events` | Folder where one MD note per event lives. Era notes go under `<dir>/_eras/`, attachments under `<dir>/_attachments/`. |
| Templates directory | `Templates` | Where the plugin writes its event template (legacy — prefer "New timeline event"). |
| Timeline id | `main` | Stored as `timeline.id` in every event note. Lets multiple `.timeline` files coexist in one vault. |

## Actions

Buttons to run import / regenerate / validate / wipe-reimport / auto-detect on demand. See [Commands](commands.md).

## Mirror property names

The plugin writes top-level `timeline_start` / `timeline_end` / `timeline_category` / etc. as Dataview-friendly mirrors of the nested `timeline.*` source of truth. Renaming any of these forces a reimport (the plugin offers it).

## Render defaults

Defaults for every ` ```timeline ` block. Per-block YAML overrides these. See [Render block reference](render-block.md).

## Category colors

Categories discovered on import are listed here with a color picker + text field. CSS color values accepted (`#aabbcc`, `rgb(r,g,b)`, `hsl(...)`, bare `r,g,b`).

## Sync & backup

| Setting | Default | Purpose |
| --- | --- | --- |
| Auto-sync Markdown → XML (global) | on | Vault-wide default. The per-device toggle overrides this. |
| Auto-sync on this device | (use global) | `localStorage` — does NOT sync with the vault. Set to **Off** on devices that shouldn't write XML. |
| Auto-sync debounce (ms) | 60000 | MD edits coalesce into one regenerate after this many idle ms. |
| Backup XML before overwriting | on | Saves `.timeline.bak-<timestamp>` next to the source. |
| Log level | info | Console verbosity. |

## Multi-device sync (advanced)

| Setting | Default | Purpose |
| --- | --- | --- |
| Backup retention (count) | 5 | Caps both XML `.bak-*` siblings AND `_backups/<label>-*` folders. Older backups deleted after every new one. |
| Prune backups now | (button) | One-shot cleanup for backups from before retention was enforced. |
| Startup grace period (ms) | 30000 | Auto-sync suppressed for this long after plugin load — lets remote sync finish initial pull. |
| Self-write suppression TTL (ms) | 5000 | How long vault events for plugin-written files are ignored. Raise if remote sync lands files later. |
| Sync log enabled | on | Appends to `_logs/timeline-sync.log` (rotated at ~200KB). |

See [Multi-device sync](multi-device-sync.md) for the conflict semantics behind these settings.
