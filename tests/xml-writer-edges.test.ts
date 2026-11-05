import { describe, expect, it } from "vitest";
import type { TimelineDoc, TimelineEvent } from "../src/timeline/model";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { writeTimelineXml } from "../src/timeline/xml-writer";
import { canonicalizeXml } from "../testUtils/canonical-xml";

const d = (year: number, month = 1, day = 1) => ({ year, month, day });
const ev = (extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "e1", text: "Event", start: d(2000), end: d(2001), isPoint: false, ...extra,
});
const write = (doc: Partial<TimelineDoc>) => writeTimelineXml({ categories: [], events: [], ...doc });
const reparse = (doc: Partial<TimelineDoc>) => parseTimelineXml(write(doc));
const sample = `<?xml version="1.0" encoding="utf-8"?>
<timeline x="1">
  <version>2.11.0</version>
  <timetype>gregoriantime</timetype>
  <categories>
    <category c="1"><name>War</name><color>1,2,3</color><odd>?</odd></category>
  </categories>
  <events>
    <event id="keep" f="1">
      <start>2000-01-01 00:00:00</start>
      <end>2000-01-02 00:00:00</end>
      <text>Raw event</text>
      <unknown>kept</unknown>
      <hyperlink>http://a</hyperlink>
      <category>War</category>
      <description><![CDATA[cdata <body>]]></description>
      <period>True</period>
    </event>
  </events>
  <eras><era k="v"><name>Era</name><start>0001-01-01 00:00:00</start><end>0009-01-01 00:00:00</end><junk/></era></eras>
  <view vz="1"><displayed_period><start>0001-01-01 00:00:00</start><end>0009-01-01 00:00:00</end></displayed_period><odd/></view>
  <custom>root</custom>
</timeline>`;

describe("writeTimelineXml: fresh document", () => {
  it("writes a declaration and an empty skeleton", () => {
    const xml = write({});
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"');
    expect(xml).toContain("<categories>");
    expect(xml).not.toContain("<eras>");
    expect(xml).not.toContain("<view>");
    expect(xml).not.toContain("<version>");
  });

  it("round-trips version, timetype and root attributes", () => {
    const back = reparse({ version: "2.11.0", timetype: "gregoriantime", xmlAttrs: { "@_k": "v" } });
    expect(back).toMatchObject({ version: "2.11.0", timetype: "gregoriantime", xmlAttrs: { "@_k": "v" } });
  });

  it("writes categories with all colours, attributes and extra nodes, skipping malformed extras", () => {
    const back = reparse({
      categories: [
        {
          name: "War", color: "1,2,3", progressColor: "4,5,6", doneColor: "7,8,9", fontColor: "0,0,0", parent: "Root",
          xmlAttrs: { "@_a": "b" },
          xmlExtraNodes: [JSON.stringify({ odd: [{ "#text": "x" }] }), "{not json", "[1]", "42"],
        },
        { name: "Bare" },
      ],
    });
    expect(back.categories[0]).toMatchObject({
      name: "War", color: "1,2,3", progressColor: "4,5,6", doneColor: "7,8,9", fontColor: "0,0,0", parent: "Root",
      xmlAttrs: { "@_a": "b" },
    });
    expect(back.categories[0].xmlExtraNodes).toHaveLength(1);
    expect(back.categories[1]).toMatchObject({ name: "Bare", color: undefined, xmlAttrs: undefined, xmlExtraNodes: undefined });
  });

  it("writes events with every optional field", () => {
    const back = reparse({
      events: [
        ev({
          category: "War", container: "C", description: "plain", hyperlinks: ["http://a", " ", "http://b"],
          labels: ["a b", "c"], progress: 40, period: true, showTime: false, fuzzyStart: true, fuzzyEnd: false,
          fuzzy: true, locked: false, endsToday: true, defaultColor: "1,2,3", icon: "AAAA", alert: "now",
          xmlAttrs: { "@_flag": "1" }, xmlExtraNodes: [JSON.stringify({ extra: [{ "#text": "x" }] })],
        }),
      ],
    }).events[0];
    expect(back).toMatchObject({
      id: "e1", text: "Event", category: "War", container: "C", description: "plain",
      hyperlinks: ["http://a", "http://b"], labels: ["a_b", "c"], progress: 40, period: true, showTime: false,
      fuzzyStart: true, fuzzyEnd: false, fuzzy: true, locked: false, endsToday: true, defaultColor: "1,2,3",
      icon: "AAAA", alert: "now", xmlAttrs: { "@_flag": "1" },
    });
    expect(back.xmlExtraNodes).toHaveLength(1);
  });

  it("falls back to the single hyperlink; writes no labels for an empty or all-blank list", () => {
    const one = reparse({ events: [ev({ hyperlink: " http://h ", labels: [] })] }).events[0];
    expect(one).toMatchObject({ hyperlinks: ["http://h"], labels: undefined });
    const blank = reparse({ events: [ev({ labels: ["  "] })] }).events[0];
    expect(blank.labels).toBeUndefined();
  });

  it("uses CDATA for descriptions containing markup characters, entities for the rest", () => {
    expect(write({ events: [ev({ description: "a <b> & c" })] })).toContain("<![CDATA[a <b> & c]]>");
    expect(write({ events: [ev({ description: "line1\nline2" })] })).toContain("<![CDATA[");
    expect(write({ events: [ev({ description: "plain" })] })).not.toContain("CDATA");
  });

  it("escapes leaf text so ampersands survive", () => {
    expect(reparse({ events: [ev({ text: "A & B" })] }).events[0].text).toBe("A & B");
  });

  it("writes eras, with attributes and extra nodes", () => {
    const back = reparse({
      eras: [
        { id: "x", name: "Era", start: d(1), end: d(9), color: "1,1,1", xmlAttrs: { "@_k": "v" }, xmlExtraNodes: [JSON.stringify({ junk: [] })] },
        { id: "y", name: "Plain", start: d(1), end: d(2) },
      ],
    });
    expect(back.eras![0]).toMatchObject({ name: "Era", color: "1,1,1", xmlAttrs: { "@_k": "v" } });
    expect(back.eras![0].xmlExtraNodes).toHaveLength(1);
    expect(back.eras![1].color).toBeUndefined();
  });

  it("writes the view in each shape", () => {
    expect(reparse({ view: { displayedPeriod: { start: d(1), end: d(9) }, hiddenCategories: ["A"], xmlAttrs: { "@_z": "1" }, xmlExtraNodes: [JSON.stringify({ odd: [] })] } }).view).toMatchObject({
      displayedPeriod: { start: { year: 1 }, end: { year: 9 } }, hiddenCategories: ["A"], xmlAttrs: { "@_z": "1" },
    });
    expect(reparse({ view: {} }).view).toMatchObject({ displayedPeriod: undefined, hiddenCategories: undefined });
  });

  it("writes root-level extra nodes when the document has no raw tree", () => {
    const back = reparse({ xmlExtraNodes: [JSON.stringify({ custom: [{ "#text": "root" }] })] });
    expect(back.xmlExtraNodes).toHaveLength(1);
  });
});

describe("writeTimelineXml: edited parse results keep what the model does not know", () => {
  it("round-trips an untouched document canonically", () => {
    expect(canonicalizeXml(writeTimelineXml(parseTimelineXml(sample)))).toBe(canonicalizeXml(sample));
  });

  it("keeps unknown children, attributes, CDATA and root extras after an edit", () => {
    const doc = parseTimelineXml(sample);
    doc.events[0].text = "Edited";
    doc.categories[0].color = "9,9,9";
    const xml = writeTimelineXml(doc);
    expect(xml).toContain("<unknown>kept</unknown>");
    expect(xml).toContain("<![CDATA[cdata <body>]]>");
    expect(xml).toContain("<odd>?</odd>");
    expect(xml).toContain("<junk");
    expect(xml).toContain("<custom>root</custom>");
    const back = parseTimelineXml(xml);
    expect(back.events[0]).toMatchObject({ id: "keep", text: "Edited", xmlAttrs: { "@_f": "1" } });
    expect(back.categories[0]).toMatchObject({ color: "9,9,9", xmlAttrs: { "@_c": "1" } });
    expect(back.xmlAttrs).toEqual({ "@_x": "1" });
    expect(back.view?.xmlExtraNodes).toHaveLength(1);
  });

  it("keeps field order, drops cleared fields and appends new ones", () => {
    const doc = parseTimelineXml(sample);
    const e = doc.events[0];
    e.category = undefined;
    e.hyperlink = undefined;
    e.hyperlinks = undefined;
    e.description = undefined;
    e.alert = "now";
    e.hyperlinks = ["http://x", "http://y"];
    const xml = writeTimelineXml(doc);
    expect(xml).not.toContain("<category>War</category>");
    expect(xml).not.toContain("<description>");
    expect(xml.indexOf("<text>")).toBeLessThan(xml.indexOf("<hyperlink>http://x"));
    expect(xml.indexOf("<unknown>")).toBeLessThan(xml.indexOf("<hyperlink>http://x"));
    expect(xml).toContain("<hyperlink>http://y</hyperlink>");
    expect(xml).toContain("<alert>now</alert>");
  });

  it("drops surplus raw hyperlink slots when the list shrinks", () => {
    const raw = `<timeline><events><event id="h"><start>1-01-01 00:00:00</start><end>1-01-02 00:00:00</end><text>t</text><hyperlink>a</hyperlink><hyperlink>b</hyperlink></event></events></timeline>`;
    const doc = parseTimelineXml(raw);
    doc.events[0].hyperlinks = ["only"];
    const xml = writeTimelineXml(doc);
    expect(xml.match(/<hyperlink>/g)).toHaveLength(1);
    expect(xml).toContain("<hyperlink>only</hyperlink>");
  });

  it("drops a category field the user cleared, but keeps the others in place", () => {
    const doc = parseTimelineXml(sample);
    doc.categories[0].color = undefined;
    const xml = writeTimelineXml(doc);
    expect(xml).not.toContain("<color>1,2,3</color>");
    expect(xml).toContain("<name>War</name>");
    expect(parseTimelineXml(xml).view?.xmlAttrs).toEqual({ "@_vz": "1" });
  });

  it("overrides raw attributes with model attributes and fills in a missing id", () => {
    const doc = parseTimelineXml(sample);
    doc.events[0].xmlAttrs = { "@_f": "2" };
    doc.events[0].raw = { event: (doc.events[0].raw as any).event }; // attributes stripped from the raw node
    expect(writeTimelineXml(doc)).toContain('f="2"');
    expect(writeTimelineXml(doc)).toContain('id="keep"');
  });

  it("keeps a CDATA description as CDATA even when the new text has no markup", () => {
    const doc = parseTimelineXml(sample);
    doc.events[0].description = "now plain";
    expect(writeTimelineXml(doc)).toContain("<![CDATA[now plain]]>");
  });

  it("preserves a non-timeline declaration, comments and a root with no attributes", () => {
    const withComment = `<?xml version="1.0" encoding="utf-8"?><!--note--><timeline><events/></timeline>`;
    const xml = writeTimelineXml(parseTimelineXml(withComment));
    expect(xml).toContain("<!--note-->");
    expect(xml.match(/<\?xml/g)).toHaveLength(1);
  });

  it("preserves comments at the top level and inside an event, without leaking them into text", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><!--top--><timeline><events><event id="c"><start>0001-01-01 00:00:00</start><end>0001-01-02 00:00:00</end><text>t</text><!--inner--><description>a<!--hidden-->b</description></event></events></timeline>`;
    const doc = parseTimelineXml(xml);
    expect(doc.events[0].description).toBe("ab");
    const out = writeTimelineXml(doc);
    expect(out).toContain("<!--top-->");
    expect(out).toContain("<!--inner-->");
  });

  it("adds a declaration when the parsed source had none", () => {
    const xml = writeTimelineXml(parseTimelineXml("<timeline><events/></timeline>"));
    expect(xml.startsWith("<?xml")).toBe(true);
  });
});

describe("canonicalizeXml", () => {
  it("makes whitespace-different documents identical and decodes entities once", () => {
    const a = "<timeline>\n  <events>\n    <event><text>A &apos;q&apos; &amp; B</text></event>\n  </events>\n</timeline>";
    const b = "<timeline><events><event><text>A 'q' &amp; B</text></event></events></timeline>";
    expect(canonicalizeXml(a)).toBe(canonicalizeXml(b));
    expect(canonicalizeXml(a)).not.toContain("&amp;apos;");
  });

  it("keeps whitespace-only text that is a leaf's whole content", () => {
    expect(canonicalizeXml("<timeline><text> </text></timeline>")).toContain("<text> </text>");
  });
});
