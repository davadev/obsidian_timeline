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
      // A date with no time of day round-trips to midnight.
      expect(fromJulian(toJulian(c))).toEqual({ ...c, hour: 0, minute: 0 });
    }
  });

  it("keeps the time of day", () => {
    const cases = [
      { year: 1969, month: 7, day: 20, hour: 20, minute: 17 },
      { year: 2024, month: 1, day: 1, hour: 0, minute: 0 },
      { year: 2024, month: 1, day: 1, hour: 23, minute: 59 },
      { year: -44, month: 3, day: 15, hour: 12, minute: 0 },
    ];
    for (const c of cases) {
      expect(fromJulian(toJulian(c))).toEqual(c);
    }
  });

  it("walks hour by hour without drifting or skipping a day", () => {
    const start = toJulian({ year: 2023, month: 2, day: 28, hour: 21 });
    for (let i = 0; i <= 6; i++) {
      const d = fromJulian(start + i / 24);
      expect(d.minute).toBe(0);
      expect(d.hour).toBe((21 + i) % 24);
      // 2023 is not a leap year: 28 Feb 23:00 + 1h is 1 Mar 00:00
      expect(d.day).toBe(i < 3 ? 28 : 1);
      expect(d.month).toBe(i < 3 ? 2 : 3);
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
