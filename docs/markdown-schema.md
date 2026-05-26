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
  container: null
  period: null
  show_time: null
  fuzzy_start: null
  fuzzy_end: null
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
  xml_attrs: {}
  xml_extra_nodes: []
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
| `timeline.container` | string | Optional container/group field from Timeline XML. |
| `timeline.period` | boolean | Optional explicit period flag from Timeline XML. |
| `timeline.show_time` | boolean | Optional explicit show-time flag from Timeline XML. |
| `timeline.fuzzy_start` / `timeline.fuzzy_end` | boolean | Optional per-edge fuzzy flags from Timeline XML. |
| `timeline.start` / `timeline.end` | object | `{year, month?, day?, hour?, minute?, second?}`. `year` may be any integer (negative = BCE). |
| `timeline.labels` | string[] | Labels for label-include/exclude filters. |
| `timeline.hyperlink` | string | Optional URL surfaced in the bar tooltip + list. |
| `timeline.progress` | number | Optional event progress percent. |
| `timeline.default_color` | string | Optional fallback color used when no category color applies. |
| `timeline.alert` | string | Optional Timeline alert payload. |
| `timeline.icon_path` | string | Vault-relative path to an attachment image. Round-trips into XML `<icon>` as base64. |
| `timeline.xml_attrs` | object | Human-visible event XML attributes (except `id`, mapped to `event_id`). |
| `timeline.xml_extra_nodes` | string[] | Human-visible JSON payloads for unknown event child XML nodes. |
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

By default, note writes trim leading/trailing whitespace around `## Description` for cleaner notes. Disable **Trim description whitespace on note write** in settings when you want stricter edge-whitespace fidelity.

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

## Timeline metadata note

To keep non-event XML fields human-visible in Markdown, import writes:

- `<eventNotesDir>/_timeline/timeline-metadata.md`

This note stores (inside `timeline:`):

- `version`, `timetype`
- root `xml_attrs`, root `xml_extra_nodes`
- full `categories` array (including `progress_color`, `done_color`, `font_color`, `parent`, attrs/extras)
- full `eras` array (dates/color + attrs/extras)
- `view` (`displayed_period`, `hidden_categories`, attrs/extras)

Regenerate reads this note and writes those values back to XML.
