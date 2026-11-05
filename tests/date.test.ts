import { describe, it, expect } from "vitest";
import {
  compare,
  parseXmlDate,
  parseFrontmatterDate,
  toFrontmatterString,
  toXmlString,
} from "../src/timeline/date";

describe("TimelineDate", () => {
  it("parses positive and negative years from XML format", () => {
    const a = parseXmlDate("2024-05-01 12:34:56");
    expect(a).toEqual({
      year: 2024,
      month: 5,
      day: 1,
      hour: 12,
      minute: 34,
      second: 56,
    });
    const b = parseXmlDate("-0454-03-30 00:00:00");
    expect(b).toEqual({
      year: -454,
      month: 3,
      day: 30,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it("compares BCE/CE dates monotonically", () => {
    const a = { year: -500, month: 1, day: 1 };
    const b = { year: -100, month: 1, day: 1 };
    const c = { year: 50, month: 1, day: 1 };
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, c)).toBeLessThan(0);
    expect(compare(a, c)).toBeLessThan(0);
    expect(compare(c, a)).toBeGreaterThan(0);
  });

  it("round-trips XML date strings", () => {
    const s = "-0454-03-30 00:00:00";
    const parsed = parseXmlDate(s);
    expect(parsed).toBeTruthy();
    expect(toXmlString(parsed!)).toBe(s);
  });

  it("formats frontmatter dates with sign padding", () => {
    expect(toFrontmatterString({ year: -1, month: 2, day: 3 })).toBe(
      "-0001-02-03"
    );
    expect(toFrontmatterString({ year: 36, month: 7, day: 30 })).toBe(
      "0036-07-30"
    );
  });

  it("parses date-only frontmatter strings", () => {
    const d = parseFrontmatterDate("-0001-02-03");
    expect(d).toEqual({ year: -1, month: 2, day: 3 });
  });
});
