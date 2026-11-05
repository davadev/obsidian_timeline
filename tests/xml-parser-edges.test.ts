import { describe, expect, it } from "vitest";
import { decodeEntities, parseTimelineXml } from "../src/timeline/xml-parser";

const doc = (inner: string, attrs = "") => `<?xml version="1.0" encoding="utf-8"?><timeline${attrs}>${inner}</timeline>`;
const event = (inner: string, attrs = "") =>
  `<event${attrs}><start>2000-01-01 00:00:00</start><end>2000-01-02 00:00:00</end>${inner}</event>`;
const events = (...evs: string[]) => doc(`<events>${evs.join("")}</events>`);
const first = (xml: string) => parseTimelineXml(xml).events[0];

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(`a & b <c> "d" 'e'`);
    expect(decodeEntities("&#10;&#x41;&#x4a;")).toBe("\nAJ");
    // XML only allows a lowercase x in hex references.
    expect(decodeEntities("&#X42;")).toBe("&#X42;");
  });
  it("leaves unknown, out-of-range and empty input alone", () => {
    expect(decodeEntities("&nbsp; &#1114112; &#99999999999;")).toBe("&nbsp; &#1114112; &#99999999999;");
    expect(decodeEntities("")).toBe("");
    expect(decodeEntities("plain")).toBe("plain");
  });
  it("passes a lone surrogate code point through without throwing", () => {
    expect(decodeEntities("&#xD800;")).toBe("\ud800");
  });
});

describe("parseTimelineXml: structure", () => {
  it("throws when there is no <timeline> root", () => {
    expect(() => parseTimelineXml("<?xml version='1.0'?><other/>")).toThrow(/missing <timeline> root/);
  });

  it("reads version, timetype, root attributes and keeps unknown root nodes", () => {
    const d = parseTimelineXml(doc("<version>2.11.0</version><timetype>gregoriantime</timetype><extra><a>1</a></extra>", ' foo="bar"'));
    expect(d).toMatchObject({ version: "2.11.0", timetype: "gregoriantime", xmlAttrs: { "@_foo": "bar" }, events: [], categories: [], eras: [] });
    expect(d.view).toBeUndefined();
    expect(d.xmlExtraNodes).toHaveLength(1);
    expect(JSON.parse(d.xmlExtraNodes![0])).toHaveProperty("extra");
  });

  it("has no extras or attributes on a minimal document", () => {
    const d = parseTimelineXml(doc(""));
    expect(d.xmlAttrs).toBeUndefined();
    expect(d.xmlExtraNodes).toBeUndefined();
  });

  it("reads categories with every colour field, attributes and unknown children", () => {
    const d = parseTimelineXml(
      doc(
        `<categories><category x="1"><name>War</name><color>1,2,3</color><progress_color>4,5,6</progress_color>` +
          `<done_color>7,8,9</done_color><font_color>0,0,0</font_color><parent>Root</parent><odd>?</odd></category>` +
          `<category><color>9,9,9</color></category></categories>`,
      ),
    );
    expect(d.categories[0]).toMatchObject({
      name: "War", color: "1,2,3", progressColor: "4,5,6", doneColor: "7,8,9", fontColor: "0,0,0", parent: "Root",
      xmlAttrs: { "@_x": "1" },
    });
    expect(d.categories[0].xmlExtraNodes).toHaveLength(1);
    expect(d.categories[1]).toMatchObject({ name: "", xmlAttrs: undefined, xmlExtraNodes: undefined });
  });

  it("reads eras, slugs their ids uniquely, and skips ones with bad dates", () => {
    const era = (n: string, s: string, e: string, extra = "") =>
      `<era${extra}><name>${n}</name><start>${s}</start><end>${e}</end><color>1,1,1</color></era>`;
    const d = parseTimelineXml(
      doc(
        `<eras>${era("Iron Age", "-1200-01-01 00:00:00", "-600-01-01 00:00:00", ' k="v"')}` +
          `${era("Iron Age", "1-01-01 00:00:00", "2-01-01 00:00:00")}${era("Bad", "nope", "2-01-01 00:00:00")}` +
          `<era><start>1-01-01 00:00:00</start><end>2-01-01 00:00:00</end><junk/></era></eras>`,
      ),
    );
    expect(d.eras!.map((e) => e.id)).toEqual(["iron-age", "iron-age-2", "era"]);
    expect(d.eras![0]).toMatchObject({ name: "Iron Age", color: "1,1,1", xmlAttrs: { "@_k": "v" }, start: { year: -1200 } });
    expect(d.eras![2].name).toBe("");
    expect(d.eras![2].xmlExtraNodes).toHaveLength(1);
  });

  it("reads the view, displayed period and hidden categories", () => {
    const d = parseTimelineXml(
      doc(
        `<view z="1"><displayed_period><start>1-01-01 00:00:00</start><end>9-01-01 00:00:00</end></displayed_period>` +
          `<hidden_categories><name>A</name><name>B &amp; C</name></hidden_categories><odd/></view>`,
      ),
    );
    expect(d.view).toMatchObject({
      displayedPeriod: { start: { year: 1 }, end: { year: 9 } },
      hiddenCategories: ["A", "B & C"],
      xmlAttrs: { "@_z": "1" },
    });
    expect(d.view?.xmlExtraNodes).toHaveLength(1);
  });

  it("tolerates an empty view and an incomplete displayed period", () => {
    expect(parseTimelineXml(doc("<view/>")).view).toMatchObject({ displayedPeriod: undefined, hiddenCategories: undefined });
    const half = parseTimelineXml(doc("<view><displayed_period><start>1-01-01 00:00:00</start></displayed_period></view>"));
    expect(half.view?.displayedPeriod).toBeUndefined();
  });
});

describe("parseTimelineXml: events", () => {
  it("skips events with a missing or malformed date", () => {
    const d = parseTimelineXml(
      events(
        "<event><text>no dates</text></event>",
        "<event><start>garbage</start><end>2000-01-01 00:00:00</end></event>",
        "<event><start>2000-01-01 00:00:00</start></event>",
        event("<text>ok</text>"),
      ),
    );
    expect(d.events.map((e) => e.text)).toEqual(["ok"]);
  });

  it("uses the id attribute, else a unique slug of the text, else 'event'", () => {
    const d = parseTimelineXml(
      events(event("<text>Rome</text>", ' id="fixed"'), event("<text>Rome</text>"), event("<text>Rome</text>"), event("")),
    );
    expect(d.events.map((e) => e.id)).toEqual(["fixed", "rome", "rome-2", "event"]);
    expect(d.events[0].xmlAttrs).toBeUndefined();
    expect(d.events[3].text).toBe("");
  });

  it("flags point events only when every component matches", () => {
    const point = parseTimelineXml(events("<event><start>5-01-01 00:00:00</start><end>5-01-01 00:00:00</end></event>")).events[0];
    expect(point.isPoint).toBe(true);
    expect(first(events(event(""))).isPoint).toBe(false);
  });

  it("parses booleans in every accepted spelling, ignoring junk and non-breaking spaces", () => {
    const flag = (v: string) => first(events(event(`<locked>${v}</locked>`))).locked;
    for (const t of ["true", "TRUE", "1", "yes", "on", " true "]) expect(flag(t), t).toBe(true);
    for (const f of ["false", "0", "no", "off"]) expect(flag(f), f).toBe(false);
    expect(flag("maybe")).toBeUndefined();
    expect(first(events(event(""))).locked).toBeUndefined();
  });

  it("parses numbers and rejects non-finite ones", () => {
    expect(first(events(event("<progress>42.5</progress>"))).progress).toBe(42.5);
    expect(first(events(event("<progress>lots</progress>"))).progress).toBeUndefined();
    expect(first(events(event(""))).progress).toBeUndefined();
  });

  it("reads simple fields, labels, several hyperlinks and unknown nodes", () => {
    const ev = first(
      events(
        event(
          `<text>T</text><category>C</category><container>K</container><labels>a  b c</labels>` +
            `<hyperlink>http://a</hyperlink><hyperlink> </hyperlink><hyperlink>http://b</hyperlink>` +
            `<default_color>1,2,3</default_color><icon>AAAA</icon><alert>now</alert><period>true</period>` +
            `<show_time>false</show_time><fuzzy_start>1</fuzzy_start><fuzzy_end>0</fuzzy_end><fuzzy>yes</fuzzy>` +
            `<ends_today>on</ends_today><custom>x</custom>`,
          ' flag="1"',
        ),
      ),
    );
    expect(ev).toMatchObject({
      text: "T", category: "C", container: "K", labels: ["a", "b", "c"], hyperlinks: ["http://a", "http://b"],
      hyperlink: "http://a", defaultColor: "1,2,3", icon: "AAAA", alert: "now", period: true, showTime: false,
      fuzzyStart: true, fuzzyEnd: false, fuzzy: true, endsToday: true, xmlAttrs: { "@_flag": "1" },
    });
    expect(ev.xmlExtraNodes).toHaveLength(1);
  });

  it("falls back to the first hyperlink's raw text, and gives no labels for an empty element", () => {
    const ev = first(events(event("<hyperlink> </hyperlink><labels></labels>")));
    expect(ev.hyperlinks).toBeUndefined();
    expect(ev.hyperlink).toBe(" ");
    expect(ev.labels).toBeUndefined();
  });

  it("reads descriptions with inline markup, br, nested elements, CDATA and entities", () => {
    const desc = (inner: string) => first(events(event(`<description>${inner}</description>`))).description;
    expect(desc("a&amp;b<br/>c<i>d<b>e</b></i>f")).toBe("a&b\ncdef");
    expect(desc("<![CDATA[<raw> &amp;]]>tail")).toBe("<raw> &amp;tail");
    expect(desc("")).toBe("");
  });
});
