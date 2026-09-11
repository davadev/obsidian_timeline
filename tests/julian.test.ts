import { describe, expect, it } from "vitest";
import { fromJulian, toJulian } from "../src/timeline/date";

describe("fromJulian", () => {
  it("round-trips dates across eras", () => {
    const cases = [
      { year: 2024, month: 2, day: 29 },
      { year: 1969, month: 7, day: 20 },
      { year: 1, month: 1, day: 1 },
      { year: -44, month: 3, day: 15 },
      { year: -900, month: 12, day: 31 },
      { year: 1582, month: 10, day: 15 },
    ];
    for (const c of cases) {
      expect(fromJulian(toJulian(c))).toEqual(c);
    }
  });

  it("stays monotone across a long walk of days", () => {
    const start = toJulian({ year: 1899, month: 12, day: 25 });
    let previous = -Infinity;
    for (let i = 0; i < 500; i++) {
      const d = fromJulian(start + i);
      const j = toJulian(d);
      expect(j).toBeGreaterThan(previous);
      previous = j;
      expect(d.month).toBeGreaterThanOrEqual(1);
      expect(d.month).toBeLessThanOrEqual(12);
      expect(d.day).toBeGreaterThanOrEqual(1);
      expect(d.day).toBeLessThanOrEqual(31);
    }
  });
});
