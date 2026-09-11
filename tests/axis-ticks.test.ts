import { describe, expect, it } from "vitest";
import {
  axisTicks,
  formatTick,
  pickStep,
  stepDays,
  visibleAxisTicks,
} from "../src/renderer/axis-ticks";

const YEAR = 365.2425;

describe("pickStep", () => {
  it("uses coarse steps when the whole span is squeezed into a pane", () => {
    // 2000 years across 800px
    const step = pickStep(2000 * YEAR, 800, 120);
    expect(step.unit).toBe("year");
    expect(step.count).toBeGreaterThanOrEqual(200);
  });

  it("gets finer as the axis grows for the same span", () => {
    const span = 200 * YEAR;
    const far = pickStep(span, 800, 120);
    const near = pickStep(span, 40000, 120);
    expect(stepDays(near)).toBeLessThan(stepDays(far));
  });

  it("reaches months and then days at high zoom", () => {
    const span = 20 * YEAR;
    expect(pickStep(span, 20000, 120).unit).toBe("month");
    expect(pickStep(span, 900000, 120).unit).toBe("day");
  });

  it("never returns a step denser than the target spacing allows", () => {
    const span = 500 * YEAR;
    const axisPx = 5000;
    const step = pickStep(span, axisPx, 120);
    const spacing = (stepDays(step) / span) * axisPx;
    expect(spacing).toBeGreaterThanOrEqual(120);
  });
});

describe("axisTicks", () => {
  it("lands on round years, not on fractions of the span", () => {
    const ticks = axisTicks({ year: 1783 }, { year: 2041 }, 1200, 120);
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) {
      expect(tick.label).toMatch(/^\d+$/);
      expect(Number(tick.label) % 50).toBe(0);
    }
  });

  it("keeps every tick inside the viewport", () => {
    const ticks = axisTicks({ year: -450 }, { year: 120 }, 2400, 120);
    expect(ticks.length).toBeGreaterThan(1);
    for (const tick of ticks) {
      expect(tick.t).toBeGreaterThanOrEqual(0);
      expect(tick.t).toBeLessThanOrEqual(1);
    }
    // monotonically increasing
    const ts = ticks.map((t) => t.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("labels BCE years", () => {
    const ticks = axisTicks({ year: -900 }, { year: -600 }, 1200, 120);
    expect(ticks.some((t) => t.label.endsWith("BCE"))).toBe(true);
  });

  it("names months when zoomed into a couple of decades", () => {
    const ticks = axisTicks({ year: 1990 }, { year: 2010 }, 30000, 120);
    expect(ticks[0].label).toMatch(/^[A-Z][a-z]{2} \d+$/);
  });

  it("names days when zoomed into a single year", () => {
    const ticks = axisTicks(
      { year: 2024, month: 1, day: 1 },
      { year: 2024, month: 3, day: 1 },
      20000,
      120
    );
    expect(ticks[0].label).toMatch(/^\d+ [A-Z][a-z]{2} \d+$/);
    // crosses a month boundary correctly (Jan has 31 days)
    expect(ticks.some((t) => t.label.includes("Feb"))).toBe(true);
  });

  it("caps the tick count however extreme the zoom", () => {
    const ticks = axisTicks({ year: 1000 }, { year: 2000 }, 5_000_000, 120);
    expect(ticks.length).toBeLessThanOrEqual(600);
  });

  it("returns nothing for a degenerate viewport", () => {
    expect(axisTicks({ year: 1900 }, { year: 1900 }, 800, 120)).toEqual([]);
    expect(axisTicks({ year: 1900 }, { year: 2000 }, 0, 120)).toEqual([]);
  });
});

describe("formatTick", () => {
  it("formats by unit", () => {
    expect(formatTick({ year: 1984 }, "year")).toBe("1984");
    expect(formatTick({ year: -44 }, "year")).toBe("44 BCE");
    expect(formatTick({ year: 1984, month: 7 }, "month")).toBe("Jul 1984");
    expect(formatTick({ year: 1984, month: 7, day: 4 }, "day")).toBe("4 Jul 1984");
  });
});

describe("visibleAxisTicks", () => {
  it("labels the window you are looking at, not the whole axis", () => {
    // 2930 years drawn across a million pixels; look at a 400px slice
    const ticks = visibleAxisTicks(
      { year: -900 },
      { year: 2030 },
      1_000_000,
      500_000,
      500_400,
      120
    );
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(60); // a window, not the whole axis
    // every mark sits within the window plus its margin
    for (const t of ticks) {
      expect(t.px).toBeGreaterThan(400_000);
      expect(t.px).toBeLessThan(600_000);
    }
  });

  it("reaches month labels for a long span once the axis is wide enough", () => {
    const ticks = visibleAxisTicks(
      { year: -900 },
      { year: 2030 },
      1_000_000,
      500_000,
      500_400,
      120
    );
    expect(ticks.some((t) => /^[A-Z][a-z]{2} /.test(t.label))).toBe(true);
  });

  it("keeps year labels when the whole span fits the pane", () => {
    const ticks = visibleAxisTicks({ year: -900 }, { year: 2030 }, 800, 0, 800, 120);
    expect(ticks.every((t) => /^\d+( BCE)?$/.test(t.label))).toBe(true);
  });

  it("covers the far end of the axis, not just the start", () => {
    const ticks = visibleAxisTicks(
      { year: 1000 },
      { year: 2000 },
      500_000,
      499_000,
      500_000,
      120
    );
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.some((t) => t.label.includes("2000") || t.label.includes("1999"))).toBe(true);
  });
});

describe("hour ticks", () => {
  const DAY = 1;

  it("descends to hours once a day is spread across a pane", () => {
    // one day across 2400px: 100px per hour
    const step = pickStep(DAY, 2400, 90);
    expect(step.unit).toBe("hour");
    expect(step.count).toBe(1);
  });

  it("uses coarser hour rungs when a day is tighter", () => {
    expect(pickStep(DAY, 600, 120).unit).toBe("hour");
    expect(pickStep(DAY, 600, 120).count).toBeGreaterThan(1);
  });

  it("lands marks on the clock, aligned to midnight", () => {
    const ticks = axisTicks(
      { year: 2024, month: 3, day: 10, hour: 1 },
      { year: 2024, month: 3, day: 10, hour: 23 },
      2000,
      120
    );
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) {
      // "06:00" or the day name at midnight
      expect(t.label).toMatch(/^(\d{2}:00|\d+ [A-Z][a-z]{2} \d+)$/);
    }
  });

  it("names the day at midnight and the clock elsewhere", () => {
    expect(formatTick({ year: 1984, month: 7, day: 4, hour: 0, minute: 0 }, "hour")).toBe(
      "4 Jul 1984"
    );
    expect(formatTick({ year: 1984, month: 7, day: 4, hour: 14, minute: 0 }, "hour")).toBe(
      "14:00"
    );
  });

  it("crosses midnight into the next day", () => {
    const ticks = axisTicks(
      { year: 2024, month: 3, day: 10, hour: 18 },
      { year: 2024, month: 3, day: 11, hour: 6 },
      2400,
      120
    );
    expect(ticks.some((t) => t.label === "11 Mar 2024")).toBe(true);
  });
});
