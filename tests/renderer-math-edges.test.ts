import { describe, expect, it } from "vitest";
import { formatTick, visibleAxisTicks } from "../src/renderer/axis-ticks";
import { layoutCallouts } from "../src/renderer/callouts";
import { PinchTracker } from "../src/renderer/zoom-math";
import {
  MIN_WINDOW_DAYS,
  clampWindow,
  clampZoomFor,
  pageFor,
  scrollToWindow,
  windowFor,
} from "../src/renderer/time-window";

describe("formatTick", () => {
  it("defaults missing month, day and clock parts", () => {
    expect(formatTick({ year: 2000 }, "month")).toBe("Jan 2000");
    expect(formatTick({ year: -44 }, "day")).toBe("1 Jan 44 BCE");
    expect(formatTick({ year: 2000, month: 3, day: 5 }, "hour")).toBe("5 Mar 2000");
    expect(formatTick({ year: 2000, month: 3, day: 5, hour: 6, minute: 7 }, "hour")).toBe("06:07");
    expect(formatTick({ year: 2000, month: 3, day: 5, hour: 6 }, "hour")).toBe("06:00");
  });
});

describe("visibleAxisTicks", () => {
  const a = { year: 2000 };
  const b = { year: 2010 };
  it("returns nothing for an empty axis or an empty/reversed span", () => {
    expect(visibleAxisTicks(a, b, 0, 0, 100, 50)).toEqual([]);
    expect(visibleAxisTicks(a, a, 800, 0, 800, 50)).toEqual([]);
    expect(visibleAxisTicks(b, a, 800, 0, 800, 50)).toEqual([]);
  });
});

describe("time-window clamps", () => {
  const span = { from: 0, to: 1000 };
  it("treats a bad zoom as 1", () => {
    expect(clampZoomFor(NaN, span)).toBe(1);
    expect(clampZoomFor(0, span)).toBe(1);
    expect(clampZoomFor(-3, span)).toBe(1);
  });
  it("keeps a window inside the span from either side", () => {
    expect(windowFor(10, -500, span)).toEqual({ from: 0, to: 100 });
    expect(windowFor(10, 5000, span)).toEqual({ from: 900, to: 1000 });
    expect(windowFor(10, 500, span)).toEqual({ from: 450, to: 550 });
  });
  it("clampWindow re-anchors a window that hangs over either edge", () => {
    expect(clampWindow({ from: -50, to: 50 }, span)).toEqual({ from: 0, to: 100 });
    expect(clampWindow({ from: 950, to: 1050 }, span)).toEqual({ from: 900, to: 1000 });
  });
  it("pageFor centres a capped page inside the span at either end", () => {
    expect(pageFor({ from: 0, to: 10 }, span, 100, 300)).toMatchObject({ from: 0, to: 30, px: 300 });
    expect(pageFor({ from: 990, to: 1000 }, span, 100, 300)).toMatchObject({ from: 970, to: 1000 });
    expect(pageFor({ from: 495, to: 505 }, span, 100, 300)).toMatchObject({ from: 485, to: 515 });
    expect(pageFor({ from: 0, to: 500 }, span, 100, 300)).toEqual({ from: 0, to: 1000, px: 200 });
  });
  it("scrollToWindow falls back to the pane's span when no visible days are given", () => {
    const page = { from: 0, to: 100, px: 1000 };
    expect(scrollToWindow(0, page, 200, 0).to).toBeCloseTo(20);
    expect(scrollToWindow(0, page, 200, NaN).to).toBeCloseTo(20);
    expect(scrollToWindow(0, page, 200, 5).to).toBe(5);
    expect(scrollToWindow(0, { from: 0, to: 0, px: 1000 }, 1, 0).to - 0).toBeGreaterThanOrEqual(MIN_WINDOW_DAYS);
  });
});

describe("PinchTracker", () => {
  const two = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  it("ignores a move when the two touches coincide", () => {
    const t = new PinchTracker();
    expect(t.start(two).kind).toBe("begin");
    expect(t.move([{ x: 5, y: 5 }, { x: 5, y: 5 }])).toEqual({ kind: "none" });
    expect(t.move([...two, { x: 1, y: 1 }]).kind).toBe("none");
    expect(t.move([{ x: 0, y: 0 }, { x: 200, y: 0 }])).toMatchObject({ kind: "update", scale: 2 });
  });
});

describe("layoutCallouts", () => {
  const item = (over = {}) => ({ id: "a", text: "Battle of Gaugamela", lane: 3, startPx: 100, endPx: 100, isPoint: true, ...over });
  it("works with the default character-width estimate and an unoccupied lane", () => {
    const out = layoutCallouts([item()], [], 800);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", lane: 3, side: "after" });
  });
  it("places nothing when not even a single character plus ellipsis fits", () => {
    // minChars 0 makes the pre-check pass on "…" alone, but one letter + "…" is wider than the room.
    const measure = (t: string) => (t === "…" ? 1 : t.length * 10);
    const out = layoutCallouts([item({ text: "Abcdefgh" })], [{ lane: 3, from: 108, to: 400 }], 800, {
      measure, minChars: 0, maxShare: 0.01,
    });
    expect(out).toEqual([]);
  });
});
