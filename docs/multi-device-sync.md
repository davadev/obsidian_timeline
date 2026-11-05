# Multi-device sync

The plugin uses only the Obsidian Vault API — no Node, no Electron, no native modules — so it works on iOS / iPadOS / Android the same way it works on desktop.

For a vault synced across devices (Obsidian Sync, [Nextcloud + Remotely Save](https://github.com/remotely-save/remotely-save), iCloud full-vault, Syncthing) the plugin includes safety nets to avoid silent data loss when two devices write the same file.

## Conflict policy

**Last-write-wins, but guarded.**

| Event | Behaviour |
| --- | --- |
| `regenerateXml` and the XML changed externally since the cache read | **Abort** + Notice + sync-log entry. User runs `Import XML` to pull, then retries. |
| `importXml` and a note has been edited since the plugin wrote it | **Skip** that note. Every note the import writes starts with a `timeline_hash:` line, a fingerprint of its own text: if the text still matches, the note is untouched and is updated in place (or left alone when nothing changed); if it does not, someone edited it. Notes without the line (older versions, or after an inspector save) fall back to the old rule (`file.mtime > last_synced_xml_mtime + 2s`). The Notice counts skipped notes. Run **Regenerate XML** to push them, or **Wipe and reimport** to overwrite. A note renamed or moved inside the events folder is found by its `event_id`. |
| `wipeAndReimport` | Backs up XML to `<path>.bak-<ts>`. Backs up every event + era MD into `_backups/wipe-<ts>/`. Prunes old backups per the retention setting. Only then deletes + reimports. Snapshots are never touched by the wipe, and notes under the backup folder are ignored by sync, the id index and the renderer. |
| `regenerateXml` and the XML has changed since the last import or write (saved in Timeline Project, or landed from another device; same bytes with a new timestamp do not count) | **Abort** + Notice + `regen-aborted-xml-newer` log entry, so stale notes cannot undo that edit. Run **Import XML** first: it updates untouched notes and keeps edited ones, then regenerate. |
| `importXml` and an event is gone from the XML | Its note is moved to the trash if it still carries an intact `timeline_hash` (nobody edited it). Edited, unsealed and hand-written notes are kept, and a XML with no events removes nothing. Logged as `import-removed`. Without this the next regenerate would write the event back. |
| `regenerateXml` finds no event notes but the XML has events (folder not synced in yet, or emptied by accident) | **Abort** + Notice + `regen-aborted-no-notes` log entry. The XML is left alone. |
| `regenerateXml` produces the same XML as the file already holds | The file is not written, so its mtime does not move and other devices see no change. Events keep the order they have in the XML; new ones go last. |
| Auto-sync fires while the previous run is still going | Runs are serialised; edits made meanwhile cause exactly one catch-up run. |
| A note without frontmatter (a README, say) sits in the events folder | Ignored. Only YAML that fails to parse is reported, since that could be an event. |
| Remote XML edit detected (mtime moved **and** the contents differ from the fingerprint of what was last imported/written) | One-shot Notice prompts the user to run `Import XML`. Logged under `external-xml-change`. A file whose mtime moved but whose bytes are unchanged — what iCloud, Remotely Save and friends do on re-download — is adopted silently. |
| Filter block YAML write fails because another device rewrote the block | Re-reads the file, retries once with the freshest body. If still failing, logged as `filter-persist-failed`. |

## Per-device sync toggle

`Settings → Timeline XML Sync → Auto-sync on this device` is stored in `localStorage` (not synced with the vault). Common setup:

- **Desktop**: auto-sync on. Owns the XML.
- **iPhone / iPad**: auto-sync off. The XML isn't even shipped to the phone; the phone reads + edits MD notes only.

## Backup retention

- `backupRetention` setting (default **5**) caps both:
  - XML `.bak-*` siblings next to the source.
  - `_backups/<label>-*` folders.
- Pruning runs synchronously after every backup is created — count never drifts above the cap. XML backups are ranked by the timestamp in their name, so a sync client that re-downloads them cannot make the wrong ones look newest.
- **Prune backups now** button in settings does a one-shot cleanup of pile-ups from before retention was enforced.

## Self-write suppression

When the plugin writes a file, the resulting `vault.on("modify")` event would normally re-trigger auto-sync (infinite loop). To prevent this, every write stamps a per-path entry in a self-write map with a 5-second TTL (configurable). Vault events for those paths within the TTL are ignored. The 5s default tolerates remote-sync round-trip latency that a shorter TTL wouldn't.

## Startup grace

The 30-second window after plugin load defers all auto-sync triggers. This lets the sync layer (Remotely Save, Nextcloud client, iCloud) finish its initial pull on a fresh open before the plugin starts writing.

## Sync log

`_logs/timeline-sync.log` is an append-only audit trail (rotated at ~200KB). Tab-separated, one event per line:

```
2026-05-26T08:00:00.000Z<TAB>regen-aborted-external-change<TAB>timelines/Rome.timeline<TAB>base=1234 now=5678 lastWritten=1234
```

Events recorded: `import-skipped`, `import-removed`, `regen-aborted-xml-newer`, `regen-aborted-no-notes`, `regen-aborted-external-change`, `external-xml-change`, `wipe-backup`, `filter-persist-failed`. Turn off via the **Sync log enabled** toggle.

## After upgrading from a version without stamps

Existing notes have no `last_synced_xml_mtime` stamp. The very next `Import XML` will skip every note as "unknown provenance" — safe behaviour but surprising the first time. Run **Wipe and reimport** once (it backs up first) to baseline them.
