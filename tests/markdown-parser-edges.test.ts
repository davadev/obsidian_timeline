import { describe, expect, it } from "vitest";
import { extractSection, parseEventNote } from "../src/timeline/markdown-parser";

const note = (tl: string, top = "", body = "\n# Heading\n") =>
  `---\n${top}timeline:\n  enabled: true\n${tl}\n---\n${body}`;
const parse = (raw: string) => parseEventNote(raw, { path: "e.md" });
const dates = "  start: {year: 1}\n  end: {year: 2}";

describe("parseEventNote: frontmatter problems", () => {
  it("ignores notes without a frontmatter mapping and reports invalid YAML", () => {
    for (const raw of ["plain", "---\n- a\n---\n", "---\n\n---\n"]) {
      expect(parse(raw)).toEqual({ errors: [] });
    }
    expect(parse("---\nkey: [oops\n---\n").errors[0]).toMatch(/^Invalid YAML frontmatter: /);
  });

  it("silently ignores notes that are not enabled events", () => {
    expect(parse("---\ntitle: x\n---\n")).toEqual({ errors: [] });
    expect(parse("---\ntimeline: [1]\n---\n")).toEqual({ errors: [] });
    expect(parse("---\ntimeline:\n  enabled: false\n---\n")).toEqual({ errors: [] });
    expect(parse(note("  role: metadata\n" + dates))).toEqual({ errors: [] });
  });
});

describe("parseEventNote: dates", () => {
  it("reports missing dates and bad years", () => {
    expect(parse(note("  end: {year: 2}")).errors).toEqual(["Missing required field: timeline.start"]);
    expect(parse(note("  start: {year: 1.5}\n  end: {year: x}")).errors).toEqual([
      "timeline.start.year must be an integer",
      "timeline.end.year must be an integer",
    ]);
    expect(parse(note("  start: nonsense\n  end: [1]")).errors).toEqual([
      "timeline.start is not a valid date",
      "timeline.end is not a valid date",
    ]);
  });

  it("accepts scalar dates, integer-like strings and flags point events", () => {
    const r = parse(note("  start: 1914-07-28\n  end: 1914-07-28"));
    expect(r.note?.event).toMatchObject({ start: { year: 1914, month: 7, day: 28 }, isPoint: true });
    const r2 = parse(note("  start: {year: 1, month: '2', day: 3.5, hour: 4}\n  end: {year: 1}"));
    expect(r2.note?.event).toMatchObject({ start: { year: 1, month: 2, day: undefined, hour: 4 }, isPoint: false });
  });
});

describe("parseEventNote: fields", () => {
  it("takes title, then the H1, then 'Untitled'; id from event_id or the slug", () => {
    expect(parse(note(dates, "title: '  My Event '\n")).note?.event).toMatchObject({ text: "My Event", id: "my-event" });
    expect(parse(note(dates + "\n  event_id: ' custom '")).note?.event).toMatchObject({ text: "Heading", id: "custom" });
    expect(parse(note(dates, "", "\nno heading\n")).note?.event).toMatchObject({ text: "Untitled", id: "untitled" });
  });

  it("reads every typed field and ignores wrong types", () => {
    const ev = parse(
      note(
        [
          dates,
          "  category: War",
          "  container: C",
          "  hyperlink: http://a",
          "  hyperlinks: [http://a, 3, http://b]",
          "  labels: [x]",
          "  progress: 40",
          "  period: true",
          "  show_time: true",
          "  fuzzy_start: false",
          "  fuzzy_end: true",
          "  fuzzy: false",
          "  locked: true",
          "  ends_today: true",
          "  default_color: '1,2,3'",
          "  icon: AAAA",
          "  icon_path: i.png",
          "  alert: now",
          "  id: tl1",
          "  source_xml: t.timeline",
          "  render: false",
          "  xml_attrs: {a: b, n: 1}",
          "  xml_extra_nodes: ['<x/>']",
          "  last_synced_xml_mtime: 12",
        ].join("\n"),
      ),
    ).note!.event;
    expect(ev).toMatchObject({
      category: "War", container: "C", hyperlink: "http://a", hyperlinks: ["http://a", "http://b"],
      labels: ["x"], progress: 40, period: true, showTime: true, fuzzyStart: false, fuzzyEnd: true, fuzzy: false,
      locked: true, endsToday: true, defaultColor: "1,2,3", icon: "AAAA", iconAttachmentPath: "i.png",
      alert: "now", timelineEnabled: true, timelineId: "tl1", sourceXml: "t.timeline", render: false,
      xmlAttrs: { a: "b" }, xmlExtraNodes: ["<x/>"], lastSyncedXmlMtime: 12,
    });
    const junk = parse(note(dates + "\n  progress: lots\n  period: yes\n  labels: [1]\n  xml_attrs: [1]\n  category: '  '")).note!.event;
    expect(parse(note(dates + "\n  xml_attrs: {n: 1}")).note?.event.xmlAttrs).toBeUndefined();
    expect(junk).toMatchObject({ progress: undefined, period: undefined, labels: undefined, xmlAttrs: undefined, category: undefined });
  });

  it("mirrors the single hyperlink into the list and the list's first into the single", () => {
    expect(parse(note(dates + "\n  hyperlink: http://a")).note?.event.hyperlinks).toEqual(["http://a"]);
    expect(parse(note(dates + "\n  hyperlinks: [http://b]")).note?.event.hyperlink).toBe("http://b");
  });

  it("falls back to the mirrored category property and honours custom mirror names", () => {
    expect(parse(note(dates, "timeline_category: Mirror\n")).note?.event.category).toBe("Mirror");
    const custom = parseEventNote(note(dates, "cat: Custom\nfoo: 1\n"), {
      path: "e.md",
      mirrorNames: { start: "s", end: "e", category: "cat", eventId: "i", render: "r", role: "ro" },
    });
    expect(custom.note?.event.category).toBe("Custom");
  });

  it("keeps non-timeline frontmatter, records mirrors seen and the body", () => {
    const r = parse(note(dates, "title: T\ntags: [a]\ncustom: 1\ntimeline_start: 0001-01-01\n", "\nbody text\n"));
    expect(r.note?.extraFrontmatter).toEqual({ title: "T", tags: ["a"], custom: 1 });
    expect(r.note?.mirrors).toEqual({ timeline_start: "0001-01-01" });
    expect(r.note?.body).toBe("\nbody text\n");
    expect(r.note?.location.path).toBe("e.md");
    expect(parse(note(dates)).note?.extraFrontmatter).toEqual({});
  });
});

describe("extractSection", () => {
  it("returns '' when the heading is absent", () => {
    expect(extractSection("# Title\ntext", "Description")).toBe("");
  });
  it("reads up to the next heading, handles CRLF, trailing hashes and a z in the text", () => {
    const body = "## Description ##\r\nHezekiah of Nazareth\r\nline two\r\n\r\n## Other\r\nx";
    expect(extractSection(body, "description")).toBe("Hezekiah of Nazareth\nline two");
  });
  it("does not stop at headings inside fenced code, and reads to EOF without one", () => {
    const body = "## Description\n```\n# not a heading\n```\n~~~\n# also not\n~~~\nreal";
    expect(extractSection(body, "Description")).toBe("```\n# not a heading\n```\n~~~\n# also not\n~~~\nreal");
  });
  it("escapes regex characters in the heading name", () => {
    expect(extractSection("## A.B (c)\ntext\n", "A.B (c)")).toBe("text\n");
    expect(extractSection("## AxB\ntext", "A.B")).toBe("");
  });
});
