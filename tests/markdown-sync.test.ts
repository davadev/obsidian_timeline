import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { writeTimelineXml } from "../src/timeline/xml-writer";
import {
  renderEventMarkdown,
} from "../src/timeline/markdown-writer";
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
  it("XML → MD → MD-parse reproduces the same events", () => {
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
    // Should error on bad month AND start > end
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
    // Old events still present
    expect(out).toContain("seventy-weeks");
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
});
