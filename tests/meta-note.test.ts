import { describe, expect, it } from "vitest";
import { parseTimelineMetaNote, renderTimelineMetaNote } from "../src/timeline/meta-note";
import type { TimelineDoc } from "../src/timeline/model";

const d = (year: number, month = 1, day = 1) => ({ year, month, day });

const full: TimelineDoc = {
  version: "2.11.0",
  timetype: "gregoriantime",
  xmlAttrs: { foo: "bar" },
  xmlExtraNodes: ["<x/>"],
  categories: [
    { name: "War", color: "1,2,3", progressColor: "4,5,6", doneColor: "7,8,9", fontColor: "0,0,0", parent: "Root", xmlAttrs: { a: "b" }, xmlExtraNodes: ["<c/>"] },
    { name: "Bare" },
  ],
  events: [],
  eras: [
    { id: "e1", name: "Republic", start: d(-509), end: d(-27), color: "9,9,9", xmlAttrs: { z: "1" }, xmlExtraNodes: ["<e/>"] },
    { id: "e2", name: "Bare era", start: d(1), end: d(2) },
  ],
  view: {
    displayedPeriod: { start: d(-100), end: d(100) },
    hiddenCategories: ["Bare"],
    xmlAttrs: { v: "1" },
    xmlExtraNodes: ["<v/>"],
  },
};

describe("meta note", () => {
  it("round-trips every field with the sync stamp", () => {
    const parsed = parseTimelineMetaNote(renderTimelineMetaNote(full, "t.timeline", 1234))!;
    expect(parsed.lastSyncedXmlMtime).toBe(1234);
    expect(parsed.docPatch).toMatchObject({
      version: "2.11.0",
      timetype: "gregoriantime",
      xmlAttrs: { foo: "bar" },
      xmlExtraNodes: ["<x/>"],
    });
    expect(parsed.docPatch.categories?.[0]).toMatchObject({
      name: "War", color: "1,2,3", progressColor: "4,5,6", doneColor: "7,8,9", fontColor: "0,0,0", parent: "Root",
      xmlAttrs: { a: "b" }, xmlExtraNodes: ["<c/>"],
    });
    expect(parsed.docPatch.eras?.map((e) => [e.id, e.start.year, e.end.year])).toEqual([["e1", -509, -27], ["e2", 1, 2]]);
    expect(parsed.docPatch.view?.displayedPeriod).toEqual({ start: d(-100), end: d(100) });
    expect(parsed.docPatch.view?.hiddenCategories).toEqual(["Bare"]);
  });

  it("omits the stamp when no mtime is given and tolerates a doc with no view, eras or version", () => {
    const text = renderTimelineMetaNote({ categories: [], events: [] }, "t.timeline");
    expect(text).not.toContain("last_synced_xml_mtime");
    const parsed = parseTimelineMetaNote(text)!;
    expect(parsed.lastSyncedXmlMtime).toBeUndefined();
    expect(parsed.docPatch.eras).toEqual([]);
    expect(parsed.docPatch.version).toBeUndefined();
    expect(parsed.docPatch.view?.displayedPeriod).toBeUndefined();
  });

  it("renders a view without a displayed period", () => {
    const text = renderTimelineMetaNote({ categories: [], events: [], view: {} }, "t.timeline");
    expect(parseTimelineMetaNote(text)?.docPatch.view?.displayedPeriod).toBeUndefined();
  });

  const wrap = (yaml: string) => `---\n${yaml}\n---\n\nbody`;

  it("rejects notes that are not enabled metadata notes", () => {
    expect(parseTimelineMetaNote("no frontmatter")).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("[1, 2]"))).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("just a string"))).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("key: [unclosed"))).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("title: x"))).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("timeline: [1]"))).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("timeline:\n  enabled: false\n  role: metadata"))).toBeUndefined();
    expect(parseTimelineMetaNote(wrap("timeline:\n  enabled: true\n  role: event"))).toBeUndefined();
  });

  it("survives hand-edited junk: wrong types are dropped, bad eras fall back to year 0", () => {
    const parsed = parseTimelineMetaNote(
      wrap(
        [
          "timeline:",
          "  enabled: true",
          "  role: metadata",
          "  version: 5",
          "  xml_attrs: [1]",
          "  xml_extra_nodes: not-a-list",
          "  last_synced_xml_mtime: soon",
          "  categories: [3, {name: Ok}, {color: x}, [1]]",
          "  eras: [{start: nonsense}]",
          "  view:",
          "    displayed_period: {start: 2000-01-01}",
          "    hidden_categories: [1, 2]",
          "    xml_attrs: {n: 1}",
        ].join("\n"),
      ),
    )!;
    expect(parsed.lastSyncedXmlMtime).toBeUndefined();
    expect(parsed.docPatch.version).toBeUndefined();
    expect(parsed.docPatch.xmlAttrs).toBeUndefined();
    expect(parsed.docPatch.xmlExtraNodes).toBeUndefined();
    expect(parsed.docPatch.categories).toHaveLength(2);
    expect(parsed.docPatch.categories?.map((c) => c.name)).toEqual(["Ok", ""]);
    expect(parsed.docPatch.eras?.[0]).toMatchObject({ id: "", name: "", start: d(0), end: d(0) });
    expect(parsed.docPatch.view?.displayedPeriod).toBeUndefined();
    expect(parsed.docPatch.view?.hiddenCategories).toBeUndefined();
    expect(parsed.docPatch.view?.xmlAttrs).toBeUndefined();
  });

  it("yields no view when the view is not an object", () => {
    const parsed = parseTimelineMetaNote(wrap("timeline:\n  enabled: true\n  role: metadata\n  view: 3"))!;
    expect(parsed.docPatch.view).toBeUndefined();
    expect(parsed.docPatch.categories).toEqual([]);
  });
});
