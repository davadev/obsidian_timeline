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

  it("parses XML with >1000 numeric entity references without throwing", () => {
    // Synthesises 2000 &#10; (newline) entities inside a description so we
    // are well past fast-xml-parser's 1000-entity expansion cap.
    const heavy = "a&#10;".repeat(2000);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories/>
  <events>
    <event id="big">
      <start>2000-01-01 00:00:00</start>
      <end>2001-01-01 00:00:00</end>
      <text>Big</text>
      <description>${heavy}</description>
    </event>
  </events>
</timeline>`;
    const doc = parseTimelineXml(xml);
    expect(doc.events[0].description?.includes("a\n")).toBe(true);
    expect((doc.events[0].description ?? "").length).toBeGreaterThan(2000);
  });

  it("parses, preserves, and re-emits <eras>", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories/>
  <events/>
  <eras>
    <era>
      <name>Bronze Age</name>
      <start>-3300-01-01 00:00:00</start>
      <end>-1200-01-01 00:00:00</end>
      <color>200,160,80</color>
    </era>
    <era>
      <name>Iron Age</name>
      <start>-1200-01-01 00:00:00</start>
      <end>0476-01-01 00:00:00</end>
      <color>120,120,140</color>
    </era>
  </eras>
</timeline>`;
    const doc = parseTimelineXml(xml);
    expect(doc.eras?.length).toBe(2);
    expect(doc.eras?.[0].name).toBe("Bronze Age");
    expect(doc.eras?.[0].start.year).toBe(-3300);
    expect(doc.eras?.[1].color).toBe("120,120,140");
    const out = writeTimelineXml(doc);
    expect(out).toContain("<eras>");
    expect(out).toContain("Bronze Age");
    expect(out).toContain("Iron Age");
    expect(out).toContain("200,160,80");
  });

  it("captures description inside a CDATA section", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories/>
  <events>
    <event id="e1">
      <start>2000-01-01 00:00:00</start>
      <end>2001-01-01 00:00:00</end>
      <text>Hello</text>
      <description><![CDATA[He was a king. He ruled for 40 years.]]></description>
    </event>
  </events>
</timeline>`;
    const doc = parseTimelineXml(xml);
    expect(doc.events[0].description).toContain("He was a king");
    expect(doc.events[0].description).toContain("40 years");
  });

  it("captures full description text across inline elements (br/b/i/a)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories/>
  <events>
    <event id="e1">
      <start>2000-01-01 00:00:00</start>
      <end>2001-01-01 00:00:00</end>
      <text>Hello</text>
      <description>He<br/>was a great king. <b>Reigned</b> for <i>many</i> years.</description>
    </event>
  </events>
</timeline>`;
    const doc = parseTimelineXml(xml);
    expect(doc.events[0].description).toContain("was a great king");
    expect(doc.events[0].description).toContain("Reigned");
    expect(doc.events[0].description).toContain("many");
    expect(doc.events[0].description?.startsWith("He")).toBe(true);
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
