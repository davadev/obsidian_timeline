import { describe, expect, it } from "vitest";
import {
  compare,
  equals,
  fractionalPosition,
  parseFrontmatterDate,
  parseXmlDate,
  toXmlString,
} from "../src/timeline/date";
import { autoViewportFromEvents, filterErasToViewport } from "../src/timeline/era-utils";
import type { EventNote, TimelineEra } from "../src/timeline/model";
import { validateAll, validateEventNote } from "../src/timeline/validator";

describe("date compare", () => {
  it("orders on the first differing component, from year down to second", () => {
    const base = { year: 2000, month: 6, day: 15, hour: 12, minute: 30, second: 30 };
    expect(compare({ ...base, year: 1999 }, base)).toBeLessThan(0);
    expect(compare({ ...base, month: 7 }, base)).toBeGreaterThan(0);
    expect(compare({ ...base, day: 14 }, base)).toBeLessThan(0);
    expect(compare({ ...base, hour: 13 }, base)).toBeGreaterThan(0);
    expect(compare({ ...base, minute: 29 }, base)).toBeLessThan(0);
    expect(compare({ ...base, second: 31 }, base)).toBeGreaterThan(0);
    expect(equals({ year: 5 }, { year: 5, month: 1, day: 1 })).toBe(true);
  });
});

describe("parseXmlDate", () => {
  it("accepts an explicit plus sign and a negative year", () => {
    expect(parseXmlDate("+0044-03-15")).toMatchObject({ year: 44, month: 3, day: 15 });
    expect(parseXmlDate("-0044-03-15 12:30")).toMatchObject({ year: -44, hour: 12, minute: 30, second: undefined });
  });
  it("accepts year-only and year-month, leaving the rest undefined", () => {
    expect(parseXmlDate("1914")).toEqual({
      year: 1914, month: undefined, day: undefined, hour: undefined, minute: undefined, second: undefined,
    });
    expect(parseXmlDate("1914-07")).toMatchObject({ year: 1914, month: 7, day: undefined });
    expect(parseXmlDate("1914-07-28T01:02:03")).toMatchObject({ hour: 1, minute: 2, second: 3 });
  });
  it("returns null for blanks, non-strings and malformed text", () => {
    expect(parseXmlDate("  ")).toBeNull();
    expect(parseXmlDate(42 as unknown as string)).toBeNull();
    expect(parseXmlDate("tomorrow")).toBeNull();
  });
  it("round-trips through toXmlString", () => {
    expect(toXmlString(parseXmlDate("-0044-03-15 01:02:03")!)).toBe("-0044-03-15 01:02:03");
  });
});

describe("parseFrontmatterDate", () => {
  it("treats a bare number as a year, parses strings, rejects the rest", () => {
    expect(parseFrontmatterDate(1066)).toEqual({ year: 1066 });
    expect(parseFrontmatterDate("1066-10-14")).toMatchObject({ year: 1066, month: 10, day: 14 });
    expect(parseFrontmatterDate(null)).toBeNull();
    expect(parseFrontmatterDate({})).toBeNull();
  });
});

describe("fractionalPosition", () => {
  const s = { year: 2000 };
  const e = { year: 2010 };
  it("is 0 for a zero-length range", () => {
    expect(fractionalPosition({ year: 2005 }, s, s)).toBe(0);
  });
  it("interpolates, and clamps to [0,1] unless asked not to", () => {
    expect(fractionalPosition({ year: 2005 }, s, e)).toBeCloseTo(0.5, 2);
    expect(fractionalPosition({ year: 1990 }, s, e)).toBe(0);
    expect(fractionalPosition({ year: 2020 }, s, e)).toBe(1);
    expect(fractionalPosition({ year: 1990 }, s, e, false)).toBeLessThan(0);
    expect(fractionalPosition({ year: 2020 }, s, e, false)).toBeGreaterThan(1);
  });
});

describe("era-utils", () => {
  const era = (id: string, a: number, b: number): TimelineEra => ({
    id, name: id, start: { year: a }, end: { year: b },
  });
  const eras = [era("old", 0, 10), era("mid", 20, 30), era("edge", 40, 50)];

  it("passes eras through when there is nothing to filter by", () => {
    expect(filterErasToViewport(undefined, { start: { year: 0 }, end: { year: 1 } })).toBeUndefined();
    expect(filterErasToViewport(eras, undefined)).toBe(eras);
    expect(filterErasToViewport(eras, null)).toBe(eras);
  });
  it("keeps eras that touch the viewport, ends inclusive", () => {
    const out = filterErasToViewport(eras, { start: { year: 10 }, end: { year: 40 } })!;
    expect(out.map((e) => e.id)).toEqual(["old", "mid", "edge"]);
    expect(filterErasToViewport(eras, { start: { year: 11 }, end: { year: 19 } })).toEqual([]);
  });

  it("treats a missing month as January when ordering", () => {
    const evs = [
      { start: { year: 10, month: 5 }, end: { year: 10 } },
      { start: { year: 10 }, end: { year: 10 } },
      { start: { year: 10, month: 5 }, end: { year: 10 } },
    ];
    expect(autoViewportFromEvents(evs)?.start).toEqual({ year: 10 });
  });

  it("derives the smallest viewport covering every event", () => {
    expect(autoViewportFromEvents([])).toBeUndefined();
    const evs = [
      { start: { year: 10, month: 5 }, end: { year: 12 } },
      { start: { year: 10, month: 2 }, end: { year: 12, month: 3 } },
      { start: { year: 10, month: 2, day: 9 }, end: { year: 12, month: 3, day: 4 } },
      { start: { year: 10, month: 2, day: 1 }, end: { year: 11 } },
      { start: { year: 9 }, end: { year: 12, month: 3, day: 2 } },
      { start: { year: 9, month: 4 }, end: { year: 9 } },
      { start: { year: 9 }, end: { year: 12, month: 3, day: 4 } },
    ];
    expect(autoViewportFromEvents(evs)).toEqual({ start: { year: 9 }, end: { year: 12, month: 3, day: 4 } });
  });
});

const note = (path: string, event: Partial<EventNote["event"]>): EventNote => ({
  event: { id: "a", text: "A", start: { year: 1 }, end: { year: 2 }, isPoint: false, ...event },
  location: { path },
  extraFrontmatter: {},
  body: "",
  mirrors: {},
});
const messages = (n: EventNote) => validateEventNote(n).errors.map((e) => e.message);

describe("validateEventNote", () => {
  it("passes a good note", () => {
    expect(validateEventNote(note("a.md", {}))).toEqual({ ok: true, errors: [] });
  });
  it("reports missing id and text", () => {
    expect(messages(note("a.md", { id: "", text: "" }))).toEqual([
      "Missing timeline.event_id",
      "Missing title/text",
    ]);
  });
  it("reports every out-of-range component", () => {
    const bad = { year: 1.5, month: 13, hour: 24, minute: 60, second: 60 };
    expect(messages(note("a.md", { start: bad, end: bad }))).toEqual(
      expect.arrayContaining([
        "timeline.start.year must be an integer",
        "timeline.start.month must be 1..12",
        "timeline.start.hour must be 0..23",
        "timeline.start.minute must be 0..59",
        "timeline.start.second must be 0..59",
      ]),
    );
  });
  it("checks day against the month, including leap years and 30/31-day months", () => {
    const day = (year: number, month: number, d: number) =>
      messages(note("a.md", { start: { year, month, day: d }, end: { year: 3000 } }));
    expect(day(2000, 2, 29)).toEqual([]);
    expect(day(2024, 2, 29)).toEqual([]);
    expect(day(1900, 2, 29)).toEqual(["timeline.start.day 29 invalid for 1900-2 (max 28)"]);
    expect(day(2023, 2, 29)).toHaveLength(1);
    expect(day(2024, 4, 31)).toEqual(["timeline.start.day 31 invalid for 2024-4 (max 30)"]);
    expect(day(2024, 1, 31)).toEqual([]);
    expect(day(2024, 1, 0)).toHaveLength(1);
  });
  it("rejects a start after the end", () => {
    expect(messages(note("a.md", { start: { year: 5 }, end: { year: 4 } }))).toEqual([
      "timeline.start must be <= timeline.end",
    ]);
  });
});

describe("validateAll", () => {
  it("flags a duplicate id once per extra note, citing the first path", () => {
    const r = validateAll([note("a.md", {}), note("b.md", {}), note("c.md", { id: "" , text: "" })]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      'b.md: Duplicate timeline.event_id "a" (also in a.md)',
      "c.md: Missing timeline.event_id",
      "c.md: Missing title/text",
    ]);
  });
  it("is ok for distinct ids", () => {
    expect(validateAll([note("a.md", {}), note("b.md", { id: "b" })]).ok).toBe(true);
  });
});
