---
title: Welcome
tags:
  - Timeline
---

# Timeline XML Sync — Demo vault

A pre-built Obsidian vault showing what this plugin does, using a public-domain timeline of **the Roman world** (753 BCE → 1453 CE).

## Open this vault

1. In Obsidian, **Open another vault → Open folder as vault** → pick this `demo-vault/` folder.
2. Make sure the **Timeline XML Sync** plugin is installed (see the [main README](../README.md)).
3. Enable it under **Settings → Community plugins**.

The event notes under `Timeline events/` are **pre-imported** from `timelines/Rome.timeline`, so the inline timeline below renders immediately — no Import step required on first run.

> If you ever want to start fresh, run **Timeline XML Sync: Wipe event notes and reimport from XML**. The plain **Import XML** command is also available, but on this shipped vault it will report every note as "skipped (local edits)" — that's expected, because the on-disk files are newer than the import stamp baked into the YAML at packaging time.

Edits you make in the notes sync back to the XML automatically (auto-sync is enabled).

## See it in action

The whole Roman timeline rendered inline below — both the bar chart and the list, with category filters:

```timeline
mode: hybrid
source: main
zoom: 4
```

## More demo notes

- [[Tour - Republic]] — viewport-scoped embed (Republic era only).
- [[Tour - Caesar]] — single-event note with its own narrow timeline.
- [[Tour - Filters and embeds]] — search, label, category, and date-range filters.
