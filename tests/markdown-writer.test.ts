import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { parseEventNote } from "../src/timeline/markdown-parser";
import { renderEventMarkdown, renderExistingEventNote } from "../src/timeline/markdown-writer";
import type { EventNote, TimelineEvent } from "../src/timeline/model";

const base: TimelineEvent = { id: "e1", text: "Event", start: { year: 1 }, end: { year: 2 }, isPoint: false };
const opts = { sourceXmlPath: "t.timeline", timelineId: "tl" };
const frontOf = (text: string) => YAML.parse(text.split("---\n")[1]) as Record<string, any>;

describe("renderEventMarkdown", () => {
  it("writes canonical defaults for a bare event", () => {
    const text = renderEventMarkdown(base, opts);
    const fm = frontOf(text);
    expect(fm.title).toBe("Event");
    expect(fm.tags).toEqual(["Timeline"]);
    expect(fm.timeline).toMatchObject({
      enabled: true, id: "tl", event_id: "e1", role: "event", source_xml: "t.timeline", category: "Uncategorized",
      container: null, period: null, show_time: null, render: true, ends_today: false, hyperlink: null,
      start: { year: 1, month: null, day: null, hour: 0, minute: 0, second: 0 },
      fuzzy_start: null, fuzzy_end: null,
    });
    expect(Object.keys(fm.timeline)).not.toEqual(expect.arrayContaining(["labels", "hyperlinks", "fuzzy", "locked", "progress", "icon", "icon_path", "alert", "xml_attrs", "xml_extra_nodes", "last_synced_xml_mtime"]));
    expect(fm).toMatchObject({
      timeline_start: "0001-01-01", timeline_end: "0002-01-01", timeline_category: "Uncategorized",
      timeline_event_id: "e1", timeline_render: true, timeline_role: "event",
    });
    expect(text).toContain("## Description\n\n\n\n## Timeline");
  });

  it("writes every optional field when the event has it", () => {
    const ev: TimelineEvent = {
      ...base, timelineEnabled: false, timelineId: "own", role: "viewport", sourceXml: "x.timeline", category: "War",
      container: "C", period: true, showTime: false, render: false, endsToday: true,
      hyperlinks: [" http://a ", "", "http://b"], labels: ["l"], fuzzyStart: true, fuzzyEnd: false, fuzzy: true,
      locked: false, progress: 0, defaultColor: "1,2,3", icon: "AAAA", alert: "now",
      xmlAttrs: { a: "b" }, xmlExtraNodes: ["<x/>"], lastSyncedXmlMtime: 5,
      end: { year: 2, month: 3, day: 4, hour: 5, minute: 6, second: 7 },
    };
    const tl = frontOf(renderEventMarkdown(ev, { ...opts, sourceMtime: 99 })).timeline;
    expect(tl).toMatchObject({
      enabled: false, id: "own", role: "viewport", source_xml: "x.timeline", category: "War", container: "C",
      period: true, show_time: false, render: false, ends_today: true, hyperlink: "http://a",
      hyperlinks: ["http://a", "http://b"], labels: ["l"], fuzzy_start: true, fuzzy_end: false, fuzzy: true,
      locked: false, progress: 0, default_color: "1,2,3", icon: "AAAA", alert: "now",
      xml_attrs: { a: "b" }, xml_extra_nodes: ["<x/>"], last_synced_xml_mtime: 5,
      end: { year: 2, month: 3, day: 4, hour: 5, minute: 6, second: 7 },
    });
  });

  it("prefers the attachment path to inline icon data and adds an Image section", () => {
    const text = renderEventMarkdown({ ...base, icon: "AAAA", iconAttachmentPath: "a/i.png" }, opts);
    const tl = frontOf(text).timeline;
    expect(tl.icon_path).toBe("a/i.png");
    expect(tl.icon).toBeUndefined();
    expect(text).toContain("## Image\n\n![[a/i.png]]");
  });

  it("falls back to the single hyperlink, and to the options' mtime stamp", () => {
    const tl = frontOf(renderEventMarkdown({ ...base, hyperlink: " http://h " }, { ...opts, sourceMtime: 77 })).timeline;
    expect(tl.hyperlink).toBe("http://h");
    expect(tl.hyperlinks).toBeUndefined();
    expect(tl.last_synced_xml_mtime).toBe(77);
  });

  it("keeps the user's own title, tags and extra keys, and an explicit body", () => {
    const text = renderEventMarkdown(base, { ...opts, extraFrontmatter: { title: "Mine", tags: ["x"], custom: 1 }, body: "BODY" });
    expect(frontOf(text)).toMatchObject({ title: "Mine", tags: ["x"], custom: 1 });
    expect(text.endsWith("---\n\nBODY")).toBe(true);
  });

  it("uses custom mirror property names", () => {
    const fm = frontOf(renderEventMarkdown(base, { ...opts, mirrorNames: { start: "s", end: "e", category: "c", eventId: "i", render: "r", role: "ro" } }));
    expect(fm).toMatchObject({ s: "0001-01-01", e: "0002-01-01", c: "Uncategorized", i: "e1", r: true, ro: "event" });
  });

  it("writes an empty description section when the event has none, trimmed or not", () => {
    expect(renderEventMarkdown(base, { ...opts, trimDescription: false })).toContain("## Description\n\n\n\n## Timeline");
  });

  it("trims the description by default and keeps it verbatim when asked", () => {
    const ev = { ...base, description: "  padded  " };
    expect(renderEventMarkdown(ev, opts)).toContain("## Description\n\npadded\n");
    expect(renderEventMarkdown(ev, { ...opts, trimDescription: false })).toContain("## Description\n\n  padded  \n");
  });

  it("is read back by the parser to the same event", () => {
    const ev: TimelineEvent = { ...base, category: "War", description: "desc", labels: ["a"], progress: 30 };
    const parsed = parseEventNote(renderEventMarkdown(ev, opts), { path: "e.md" }).note!.event;
    expect(parsed).toMatchObject({ id: "e1", text: "Event", category: "War", description: "desc", labels: ["a"], progress: 30 });
  });
});

describe("renderExistingEventNote", () => {
  const note: EventNote = {
    event: { ...base, lastSyncedXmlMtime: undefined },
    location: { path: "e.md" },
    extraFrontmatter: { custom: "keep" },
    body: "existing body",
    mirrors: {},
    lastSyncedXmlMtime: 11,
  };

  it("preserves body and extra frontmatter and stamps the note's own mtime by default", () => {
    const text = renderExistingEventNote(note, "t.timeline", "tl");
    expect(text.endsWith("\n\nexisting body")).toBe(true);
    const fm = frontOf(text);
    expect(fm.custom).toBe("keep");
    expect(fm.timeline.last_synced_xml_mtime).toBe(11);
  });

  it("prefers an explicit source mtime and honours custom mirror names", () => {
    const fm = frontOf(
      renderExistingEventNote(note, "t.timeline", "tl", { start: "s", end: "e", category: "c", eventId: "i", render: "r", role: "ro" }, 22),
    );
    expect(fm.timeline.last_synced_xml_mtime).toBe(22);
    expect(fm.s).toBe("0001-01-01");
  });

  it("stamps nothing when neither the call nor the note has an mtime", () => {
    const fm = frontOf(renderExistingEventNote({ ...note, lastSyncedXmlMtime: undefined }, "t.timeline", "tl"));
    expect(fm.timeline.last_synced_xml_mtime).toBeUndefined();
  });
});
