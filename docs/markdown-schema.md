# Markdown event-note schema

Every event note has normal Obsidian YAML frontmatter. The nested `timeline:` object is the **source of truth**; the top-level `timeline_*` keys are mirrors for Dataview compatibility.

<p align="center">
  <img src="images/inspector.png" alt="Right-sidebar Inspector — title, category, BCE-safe year/month/day inputs, description with live preview, labels, hyperlink, image upload" width="400" />
</p>

You rarely need to edit the YAML by hand. The right-sidebar **Inspector** (above) edits every field on the schema directly — including the year/month/day inputs that handle BCE dates the native date picker can't.

```yaml
---
title: Caesar crosses the Rubicon
tags:
  - Timeline

timeline:
  enabled: true
  id: main
  event_id: caesar-rubicon
  role: event
  source_xml: timelines/Rome.timeline
  category: People
  render: true
  ends_today: false
  hyperlink: null
  start:
    year: -49
    month: 1
    day: 10
    hour: 0
    minute: 0
    second: 0
  end:
    year: -49
    month: 1
    day: 10
    hour: 0
    minute: 0
    second: 0
  labels: [key]
  last_synced_xml_mtime: 1716840000000

timeline_start: "-0049-01-10"
timeline_end: "-0049-01-10"
timeline_category: People
timeline_event_id: caesar-rubicon
timeline_render: true
timeline_role: event
---

# Caesar crosses the Rubicon

## Text
Caesar crosses the Rubicon

## Description
"Alea iacta est." Civil war begins.

## Timeline

```timeline
mode: hybrid
source: main
viewport: true
```
```

## Field reference

| Field | Type | Notes |
| --- | --- | --- |
| `timeline.enabled` | boolean | Must be `true` for the plugin to treat this as an event. |
| `timeline.id` | string | Logical timeline id (groups events under one XML). Matches the `timelineId` setting. |
| `timeline.event_id` | string | Stable id. Drives MD filename and XML `<event id="…">`. |
| `timeline.role` | `event` / `viewport` / `era` | `event` = synced event. `viewport` = host note whose start/end scope inline blocks. `era` = era note (auto-generated under `_eras/`). |
| `timeline.source_xml` | string | Vault path of the source `.timeline` XML. |
| `timeline.category` | string | Category name. Auto-coloured on import. |
| `timeline.start` / `timeline.end` | object | `{year, month?, day?, hour?, minute?, second?}`. `year` may be any integer (negative = BCE). |
| `timeline.labels` | string[] | Labels for label-include/exclude filters. |
| `timeline.hyperlink` | string | Optional URL surfaced in the bar tooltip + list. |
| `timeline.icon_path` | string | Vault-relative path to an attachment image. Round-trips into XML `<icon>` as base64. |
| `timeline.last_synced_xml_mtime` | number | Stamp written by `importXml`. Used to detect locally edited notes and skip overwriting them on re-import (multi-device safety). |
| `timeline_*` mirrors | various | Top-level keys for Dataview. The plugin only writes them; user edits there are NOT round-tripped — edit the nested `timeline:` block instead. |

## Date semantics

- `year` is any integer; negative = BCE. **Never funneled through a JavaScript `Date`** — comparisons use a custom ordering safe for any BCE year.
- Missing `month` / `day` etc. default to 1 / 1 / 0 / 0 / 0 (start of period) for comparison.
- For range filter end values, missing components default to **end of period** (Dec 31 23:59:59) so a year-only filter is inclusive.

## Body sections

The plugin reads these sections back from the body on every sync:

- `## Text` — the event's `<text>` (header label).
- `## Description` — free Markdown, written back into XML as CDATA. Obsidian links (`[[Note]]`, `![[Note]]`) are preserved.
- `## Timeline` — the auto-generated ` ```timeline ` block. Inserted into newly imported event notes; you can edit or delete it without affecting sync.

## Eras

Era notes live under `<eventNotesDir>/_eras/`. They have `timeline.role: era` and a separate, simpler frontmatter:

```yaml
timeline:
  enabled: true
  id: main
  era_id: roman-republic
  role: era
  color: "180,220,180"
  start:
    year: -509
  end:
    year: -27
```

Eras can be edited via the right-sidebar **Inspector** view (same as events).
