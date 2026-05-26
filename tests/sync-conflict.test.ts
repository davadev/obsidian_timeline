import { describe, it, expect } from "vitest";
import { renderEventMarkdown } from "../src/timeline/markdown-writer";
import { parseEventNote } from "../src/timeline/markdown-parser";
import { renderEraMarkdown, parseEraNote } from "../src/timeline/era-md";
import {
  shouldSkipNoteOverwrite,
  shouldAbortXmlWrite,
} from "../src/obsidian/sync-policy";
import type { TimelineEvent, TimelineEra } from "../src/timeline/model";

const baseEvent: TimelineEvent = {
  id: "test-event",
  text: "Test event",
  start: { year: -1000 },
  end: { year: -1000 },
  isPoint: true,
};

describe("Sync conflict: lastSyncedXmlMtime stamp roundtrip (events)", () => {
  it("renderEventMarkdown stamps source mtime into nested timeline block", () => {
    const md = renderEventMarkdown(baseEvent, {
      sourceXmlPath: "timelines/main.timeline",
      timelineId: "main",
      sourceMtime: 1717000000000,
    });
    expect(md).toContain("last_synced_xml_mtime: 1717000000000");
  });

  it("parseEventNote reads the stamp back as a number", () => {
    const md = renderEventMarkdown(baseEvent, {
      sourceXmlPath: "timelines/main.timeline",
      timelineId: "main",
      sourceMtime: 1717000000000,
    });
    const parsed = parseEventNote(md, { path: "events/test.md" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.note?.lastSyncedXmlMtime).toBe(1717000000000);
  });

  it("legacy notes (no stamp) parse to undefined", () => {
    const md = renderEventMarkdown(baseEvent, {
      sourceXmlPath: "timelines/main.timeline",
      timelineId: "main",
      // sourceMtime omitted
    });
    const parsed = parseEventNote(md, { path: "events/test.md" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.note?.lastSyncedXmlMtime).toBeUndefined();
  });
});

describe("Sync conflict: era stamp roundtrip", () => {
  const era: TimelineEra = {
    id: "iron-age",
    name: "Iron Age",
    start: { year: -1200, month: 1, day: 1 },
    end: { year: -550, month: 12, day: 31 },
    color: "#a37",
  };

  it("renderEraMarkdown stamps source mtime", () => {
    const md = renderEraMarkdown(era, "main", "timelines/main.timeline", 1234);
    expect(md).toContain("last_synced_xml_mtime: 1234");
  });

  it("parseEraNote roundtrips the stamp", () => {
    const md = renderEraMarkdown(era, "main", "timelines/main.timeline", 9999);
    const parsed = parseEraNote(md, era.id);
    expect(parsed?.lastSyncedXmlMtime).toBe(9999);
  });

  it("era without sourceMtime omits the stamp", () => {
    const md = renderEraMarkdown(era, "main", "timelines/main.timeline");
    expect(md).not.toContain("last_synced_xml_mtime");
    const parsed = parseEraNote(md, era.id);
    expect(parsed?.lastSyncedXmlMtime).toBeUndefined();
  });
});

describe("Sync conflict: shouldSkipNoteOverwrite", () => {
  it("allows write when file does not exist", () => {
    expect(shouldSkipNoteOverwrite(undefined, undefined)).toBe(false);
    expect(shouldSkipNoteOverwrite(undefined, 100)).toBe(false);
  });

  it("skips when note has no stamp (unknown provenance)", () => {
    expect(shouldSkipNoteOverwrite(100, undefined)).toBe(true);
  });

  it("skips when file mtime > stamp + grace (local edit)", () => {
    // grace default 2000ms
    expect(shouldSkipNoteOverwrite(5000, 100)).toBe(true);
  });

  it("allows when file mtime is within the grace window of the stamp", () => {
    // 100 + 2000 grace = 2100; mtime 2000 ≤ 2100 → allow.
    expect(shouldSkipNoteOverwrite(2000, 100)).toBe(false);
  });

  it("allows when file mtime equals stamp (just-written)", () => {
    expect(shouldSkipNoteOverwrite(100, 100)).toBe(false);
  });

  it("respects custom grace window", () => {
    // mtime 200, stamp 100, grace 50 → 200 > 150 → skip
    expect(shouldSkipNoteOverwrite(200, 100, 50)).toBe(true);
    expect(shouldSkipNoteOverwrite(140, 100, 50)).toBe(false);
  });
});

describe("Sync conflict: shouldAbortXmlWrite (CAS)", () => {
  it("does not abort when one side is missing (first write)", () => {
    expect(shouldAbortXmlWrite(null, null, null)).toBe(false);
    expect(shouldAbortXmlWrite(null, 100, null)).toBe(false);
    expect(shouldAbortXmlWrite(100, null, null)).toBe(false);
  });

  it("does not abort when mtime is stable (within tolerance)", () => {
    expect(shouldAbortXmlWrite(100, 100, null)).toBe(false);
    expect(shouldAbortXmlWrite(100, 1000, null)).toBe(false); // within 1s default
  });

  it("aborts when mtime jumped AND it does not match our last write", () => {
    expect(shouldAbortXmlWrite(100, 5000, 100)).toBe(true);
    expect(shouldAbortXmlWrite(100, 5000, null)).toBe(true);
  });

  it("does NOT abort when the new mtime matches our last write", () => {
    // e.g. we wrote at T=5000 then re-read mtime — should not trip
    expect(shouldAbortXmlWrite(100, 5000, 5000)).toBe(false);
  });

  it("respects custom tolerance", () => {
    expect(shouldAbortXmlWrite(100, 200, null, 50)).toBe(true);
    expect(shouldAbortXmlWrite(100, 140, null, 50)).toBe(false);
  });
});
