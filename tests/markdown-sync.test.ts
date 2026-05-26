import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { writeTimelineXml } from "../src/timeline/xml-writer";
import { renderEventMarkdown } from "../src/timeline/markdown-writer";
import { parseEventNote } from "../src/timeline/markdown-parser";
import { validateAll } from "../src/timeline/validator";
import { mergeNotesIntoDoc } from "../src/timeline/sync-engine";
import type { EventNote, TimelineEvent } from "../src/timeline/model";

const fixturePath = join(__dirname, "fixtures", "sample.timeline");

function noteFor(ev: TimelineEvent): EventNote {
  return {
    event: ev,
    location: { path: `events/${ev.id}.md` },
    extraFrontmatter: {},
    body: "",
    mirrors: {},
  };
}

describe("Markdown sync", () => {
  it("XML -> MD -> MD-parse reproduces the same events", () => {
    const xml = readFileSync(fixturePath, "utf-8");
    const doc = parseTimelineXml(xml);
    const notes: EventNote[] = [];
    for (const ev of doc.events) {
      const md = renderEventMarkdown(ev, {
        sourceXmlPath: "timelines/main.timeline",
        timelineId: "main",
      });
      const parsed = parseEventNote(md, { path: `events/${ev.id}.md` });
      expect(parsed.errors).toEqual([]);
      expect(parsed.note).toBeTruthy();
      notes.push(parsed.note!);
    }
    const merged = mergeNotesIntoDoc(doc, notes);
    expect(merged.events.length).toBe(doc.events.length);
    expect(merged.events.map((e) => e.id).sort()).toEqual(
      doc.events.map((e) => e.id).sort()
    );
  });

  it("invalid markdown blocks XML write", () => {
    const badMd = `---
title: Bad
timeline:
  enabled: true
  id: main
  event_id: bad
  role: event
  source_xml: x.timeline
  start:
    year: 2024
    month: 13
    day: 1
  end:
    year: 2024
    month: 1
    day: 1
---

# Bad
`;
    const parsed = parseEventNote(badMd, { path: "events/bad.md" });
    expect(parsed.note).toBeTruthy();
    const v = validateAll([parsed.note!]);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.message.includes("month must be 1..12"))).toBe(true);
    expect(v.errors.some((e) => e.message.includes("start must be <= timeline.end"))).toBe(true);
  });

  it("adding a new valid markdown event produces a valid XML containing it", () => {
    const xml = readFileSync(fixturePath, "utf-8");
    const doc = parseTimelineXml(xml);
    const notes = doc.events.map(noteFor);
    const newEv: TimelineEvent = {
      id: "new-event",
      text: "Newly added",
      start: { year: 1500, month: 6, day: 1 },
      end: { year: 1550, month: 6, day: 1 },
      isPoint: false,
      category: "NewCategory",
    };
    notes.push(noteFor(newEv));
    const merged = mergeNotesIntoDoc(doc, notes);
    expect(merged.categories.map((c) => c.name)).toContain("NewCategory");
    const out = writeTimelineXml(merged);
    expect(out).toContain("new-event");
    expect(out).toContain("Newly added");
    expect(out).toContain("NewCategory");
    expect(out).toContain("seventy-weeks");
  });

  it("extracts a multi-line description that contains the letter z", () => {
    const md = `---
title: Hezekiah
timeline:
  enabled: true
  id: main
  event_id: hez
  role: event
  source_xml: x.timeline
  start: { year: -769, month: 1, day: 1 }
  end: { year: -715, month: 1, day: 1 }
---

# Hezekiah

## Text

Hezekiah

## Description

Hezekiah was a king of Judah.
He purged the temple at Zion and trusted Yahweh.
He reigned 29 years.

## Timeline

\`\`\`timeline
mode: hybrid
\`\`\`
`;
    const parsed = parseEventNote(md, { path: "events/hez.md" });
    expect(parsed.note).toBeTruthy();
    const desc = parsed.note!.event.description ?? "";
    expect(desc).toContain("Hezekiah was a king of Judah");
    expect(desc).toContain("Zion");
    expect(desc).toContain("29 years");
  });

  it("preserves leading and trailing description whitespace through MD round-trip", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories/>
  <events>
    <event id="ws1">
      <start>2000-01-01 00:00:00</start>
      <end>2001-01-01 00:00:00</end>
      <text>Whitespace</text>
      <description><![CDATA[
  Leading space line
Middle line
Trailing space line  
]]></description>
    </event>
  </events>
</timeline>`;

    const doc = parseTimelineXml(xml);
    const ev = doc.events[0];
    const md = renderEventMarkdown(ev, {
      sourceXmlPath: "timelines/main.timeline",
      timelineId: "main",
      trimDescription: false,
    });
    const parsed = parseEventNote(md, { path: "events/ws1.md" });

    expect(parsed.note).toBeTruthy();
    expect(parsed.note!.event.description).toBe(ev.description);
  });

  it("renders MD with both nested timeline and mirror props", () => {
    const ev: TimelineEvent = {
      id: "abc",
      text: "Test",
      start: { year: -100, month: 1, day: 1 },
      end: { year: 50, month: 1, day: 1 },
      isPoint: false,
      category: "Test",
    };
    const md = renderEventMarkdown(ev, {
      sourceXmlPath: "x.timeline",
      timelineId: "main",
    });
    expect(md).toMatch(/timeline_start: -0100-01-01/);
    expect(md).toMatch(/timeline_end: 0050-01-01/);
    expect(md).toMatch(/timeline:/);
    expect(md).toMatch(/event_id: abc/);
  });

  it("parses description section heading case-insensitively", () => {
    const md = `---
title: A
timeline:
  enabled: true
  id: main
  event_id: a
  role: event
  source_xml: x.timeline
  start: { year: 2000, month: 1, day: 1 }
  end: { year: 2000, month: 1, day: 1 }
---

# A

## description ##

Hello

## Timeline
`;
    const parsed = parseEventNote(md, { path: "events/a.md" });
    expect(parsed.note?.event.description).toBe("Hello");
  });

  it("does not stop Description at heading inside fenced code", () => {
    const md = `---
title: B
timeline:
  enabled: true
  id: main
  event_id: b
  role: event
  source_xml: x.timeline
  start: { year: 2000, month: 1, day: 1 }
  end: { year: 2000, month: 1, day: 1 }
---

# B

## Description

Intro

\`\`\`
# not a section break
\`\`\`

Tail

## Timeline
`;
    const parsed = parseEventNote(md, { path: "events/b.md" });
    expect(parsed.note?.event.description).toContain("not a section break");
    expect(parsed.note?.event.description).toContain("Tail");
  });
});
