---
title: Tour - Filters and embeds
tags:
  - Timeline
  - Demo
---

# Filters, embeds, and shared blocks

Each ` ```timeline ` block carries its own YAML. Anything you can type in the **Filters** panel can also be hard-coded.

## Filter by category

Only `Wars`:

```timeline
mode: list
source: main
categories:
  include:
    - Wars
```

## Filter by label

Events tagged `key`:

```timeline
mode: list
source: main
labels:
  include:
    - key
```

## Bar with vertical orientation

```timeline
mode: bar
source: main
orientation: vertical
range: [-50, 200]
zoom: 2
```

## Embed another note

The viewport-scoped note rendered inline:

![[Tour - Republic]]
