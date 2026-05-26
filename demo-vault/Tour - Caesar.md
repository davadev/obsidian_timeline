---
title: Tour - Caesar
tags:
  - Timeline
  - Demo
---

# Julius Caesar — context

Showing how a non-event note can drop a short, focused timeline block in the middle of prose. Here, a date-range filter narrows the view to Caesar's lifetime.

Caesar was born 100 BCE, crossed the Rubicon in [[caesar-rubicon|49 BCE]], and was [[caesar-assassinated|assassinated on the Ides of March, 44 BCE]].

```timeline
mode: hybrid
source: main
range: [-110, -30]
```

Behavior:

- **No viewport hint on the host note** — the block uses its own `range:` filter to narrow the visible window.
- The filter panel above the timeline lets a reader widen/narrow without editing the block. Filter changes persist back into the block's YAML.
