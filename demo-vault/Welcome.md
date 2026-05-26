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
4. Run the command **Timeline XML Sync: Import XML to Markdown event notes**. The plugin will:
   - read `timelines/Rome.timeline`
   - write one Markdown event note per `<event>` under `Timeline events/`
   - write one MD per `<era>` under `Timeline events/_eras/`

After import you can browse, filter, and edit events as normal Markdown notes. Edits sync back to the XML automatically.

## See it in action

The whole Roman timeline rendered inline below — both the bar chart and the list, with category filters:

```timeline
mode: hybrid
source: main
zoom: 3
```

## More demo notes

- [[Tour - Republic]] — viewport-scoped embed (Republic era only).
- [[Tour - Caesar]] — single-event note with its own narrow timeline.
- [[Tour - Filters and embeds]] — search, label, category, and date-range filters.
