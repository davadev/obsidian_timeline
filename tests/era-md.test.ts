import { describe, expect, it } from "vitest";
import { parseEraNote, renderEraMarkdown } from "../src/timeline/era-md";
import type { TimelineEra } from "../src/timeline/model";

const wrap = (tl: string, top = "") => `---\n${top}timeline:\n${tl}\n---\n\n# body`;
const era = (extra = ""): string =>
  wrap(`  enabled: true\n  role: era\n  start: {year: -509, month: 3}\n  end: {year: -27}\n${extra}`);

describe("parseEraNote", () => {
  it("reads the nested start/end objects, colour and sync stamp", () => {
    const e = parseEraNote(
      wrap(
        "  enabled: true\n  role: era\n  era_id: ' rep '\n  name: Fallback\n  color: ' 1,2,3 '\n" +
          "  last_synced_xml_mtime: 99\n  start: {year: -509, month: '3', day: x, hour: 4, minute: 5, second: 6}\n  end: {year: -27}",
        "title: Republic\n",
      ),
      "file-id",
    )!;
    expect(e).toMatchObject({
      id: "rep", name: "Republic", color: "1,2,3", lastSyncedXmlMtime: 99,
      start: { year: -509, month: 3, day: undefined, hour: 4, minute: 5, second: 6 },
      end: { year: -27 },
    });
  });

  it("falls back to the file id for id and name, and to tl.name when there is no title", () => {
    expect(parseEraNote(era(), "file-id")).toMatchObject({ id: "file-id", name: "file-id", color: undefined });
    expect(parseEraNote(era("  name: Named"), "f")?.name).toBe("Named");
    expect(parseEraNote(wrap("  enabled: true\n  role: era\n  start: 2000\n  end: '2010-01-02'", "title: '  '\n"), "f")).toMatchObject({
      name: "f", start: { year: 2000 }, end: { year: 2010, month: 1, day: 2 },
    });
  });

  it("ignores a blank colour and a non-finite stamp", () => {
    const e = parseEraNote(era("  color: '  '\n  last_synced_xml_mtime: .inf"), "f")!;
    expect(e.color).toBeUndefined();
    expect(e.lastSyncedXmlMtime).toBeUndefined();
  });

  it("returns null for anything that is not an enabled era note", () => {
    expect(parseEraNote("no frontmatter", "f")).toBeNull();
    expect(parseEraNote("---\n[1]\n---\n", "f")).toBeNull();
    expect(parseEraNote("---\nkey: [oops\n---\n", "f")).toBeNull();
    expect(parseEraNote("---\ntitle: x\n---\n", "f")).toBeNull();
    expect(parseEraNote("---\ntimeline: [1]\n---\n", "f")).toBeNull();
    expect(parseEraNote(wrap("  enabled: false\n  role: era"), "f")).toBeNull();
    expect(parseEraNote(wrap("  enabled: true\n  role: event"), "f")).toBeNull();
  });

  it("returns null when a date is missing or malformed", () => {
    const base = "  enabled: true\n  role: era\n";
    expect(parseEraNote(wrap(`${base}  end: 5`), "f")).toBeNull();
    expect(parseEraNote(wrap(`${base}  start: 5`), "f")).toBeNull();
    expect(parseEraNote(wrap(`${base}  start: {year: 1.5}\n  end: 5`), "f")).toBeNull();
    expect(parseEraNote(wrap(`${base}  start: {year: x}\n  end: 5`), "f")).toBeNull();
    expect(parseEraNote(wrap(`${base}  start: [1]\n  end: 5`), "f")).toBeNull();
    expect(parseEraNote(wrap(`${base}  start: nonsense\n  end: 5`), "f")).toBeNull();
  });
});

describe("renderEraMarkdown", () => {
  const e: TimelineEra = {
    id: "e:1", name: "Republic", start: { year: -509, month: 3, day: 7 }, end: { year: 27 }, color: "1,2,3",
  };

  it("round-trips through parseEraNote", () => {
    const text = renderEraMarkdown(e, "tl", "t.timeline", 55);
    expect(text).toContain("timeline_era_start: -0509-03-07");
    expect(text).toContain("timeline_era_end: 0027-01-01");
    expect(text).toContain("> Color: `1,2,3`");
    expect(parseEraNote(text, "x")).toMatchObject({
      id: "e:1", name: "Republic", color: "1,2,3", lastSyncedXmlMtime: 55,
      start: { year: -509, month: 3, day: 7 }, end: { year: 27 },
    });
  });

  it("uses the era's own stamp when no source mtime is given, and none when neither exists", () => {
    expect(renderEraMarkdown({ ...e, lastSyncedXmlMtime: 7 }, "tl", "t")).toContain("last_synced_xml_mtime: 7");
    const bare = renderEraMarkdown({ id: "", name: "Plain", start: { year: 1 }, end: { year: 2 } }, "tl", "t");
    expect(bare).not.toContain("last_synced_xml_mtime");
    expect(bare).toContain('era_id: ""');
    expect(bare).not.toContain("> Color");
  });

  it("quotes names and ids that YAML would misread", () => {
    const text = renderEraMarkdown({ ...e, name: 'He said: "hi" \\ there', id: "-lead" }, "tl", "t");
    expect(text).toContain('title: "He said: \\"hi\\" \\\\ there"');
    expect(text).toContain('era_id: "-lead"');
  });
});
