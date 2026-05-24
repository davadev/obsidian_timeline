import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { writeTimelineXml, canonicalizeXml } from "../src/timeline/xml-writer";

const fixturePath = join(__dirname, "fixtures", "sample.timeline");

describe("XML round-trip", () => {
  it("parses fixture and re-emits canonically-equal XML", () => {
    const original = readFileSync(fixturePath, "utf-8");
    const doc = parseTimelineXml(original);
    const rewritten = writeTimelineXml(doc);

    const c1 = canonicalizeXml(original);
    const c2 = canonicalizeXml(rewritten);
    expect(c2).toBe(c1);
  });

  it("preserves event count, ids, and ordering", () => {
    const original = readFileSync(fixturePath, "utf-8");
    const doc = parseTimelineXml(original);
    expect(doc.events.length).toBe(3);
    expect(doc.events.map((e) => e.id)).toEqual([
      "seventy-weeks",
      "medo-persia",
      "point-event",
    ]);
    expect(doc.events[2].isPoint).toBe(true);
  });

  it("preserves categories", () => {
    const original = readFileSync(fixturePath, "utf-8");
    const doc = parseTimelineXml(original);
    expect(doc.categories.map((c) => c.name)).toEqual([
      "Prophecies",
      "Kingdoms",
    ]);
  });

  it("preserves the displayed_period view", () => {
    const original = readFileSync(fixturePath, "utf-8");
    const doc = parseTimelineXml(original);
    expect(doc.view?.displayedPeriod?.start.year).toBe(-500);
    expect(doc.view?.displayedPeriod?.end.year).toBe(100);
  });

  it("preserves unknown XML child elements through a round-trip", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories>
    <category>
      <name>Foo</name>
      <color>1,2,3</color>
      <future_field>preserve me</future_field>
    </category>
  </categories>
  <events>
    <event id="e1">
      <start>2000-01-01 00:00:00</start>
      <end>2001-01-01 00:00:00</end>
      <text>Hello</text>
      <category>Foo</category>
      <custom_extension>secret data</custom_extension>
    </event>
  </events>
</timeline>`;
    const doc = parseTimelineXml(xml);
    const out = writeTimelineXml(doc);
    expect(out).toContain("custom_extension");
    expect(out).toContain("secret data");
    expect(out).toContain("future_field");
    expect(out).toContain("preserve me");
  });
});
