import { describe, it, expect } from "vitest";
import {
  filterErasToViewport,
  autoViewportFromEvents,
} from "../src/timeline/era-utils";
import type { TimelineEra } from "../src/timeline/model";

const eras: TimelineEra[] = [
  { id: "ice", name: "Ice Age", start: { year: -10000 }, end: { year: -8000 } },
  { id: "iron", name: "Iron Age", start: { year: -1200 }, end: { year: -550 } },
  { id: "modern", name: "Modern", start: { year: 1500 }, end: { year: 2000 } },
];

describe("filterErasToViewport", () => {
  it("returns undefined when input is undefined", () => {
    expect(filterErasToViewport(undefined, { start: { year: 0 }, end: { year: 100 } }))
      .toBeUndefined();
  });

  it("returns input when viewport is null/undefined", () => {
    expect(filterErasToViewport(eras, null)).toEqual(eras);
    expect(filterErasToViewport(eras, undefined)).toEqual(eras);
  });

  it("keeps only eras overlapping the viewport", () => {
    const vp = { start: { year: -1000 }, end: { year: -500 } };
    const out = filterErasToViewport(eras, vp);
    expect(out?.map((e) => e.id)).toEqual(["iron"]);
  });

  it("includes era exactly touching viewport edge", () => {
    const vp = { start: { year: -1200 }, end: { year: -1200 } };
    const out = filterErasToViewport(eras, vp);
    expect(out?.map((e) => e.id)).toEqual(["iron"]);
  });

  it("excludes era entirely outside viewport", () => {
    const vp = { start: { year: 0 }, end: { year: 100 } };
    const out = filterErasToViewport(eras, vp);
    expect(out).toEqual([]);
  });

  it("keeps multiple overlapping eras", () => {
    const vp = { start: { year: -2000 }, end: { year: 1800 } };
    const out = filterErasToViewport(eras, vp);
    expect(out?.map((e) => e.id)).toEqual(["iron", "modern"]);
  });
});

describe("autoViewportFromEvents", () => {
  it("returns undefined for empty input", () => {
    expect(autoViewportFromEvents([])).toBeUndefined();
  });

  it("returns the single event's range for a one-event input", () => {
    const vp = autoViewportFromEvents([
      { start: { year: 500 }, end: { year: 600 } },
    ]);
    expect(vp).toEqual({ start: { year: 500 }, end: { year: 600 } });
  });

  it("spans min start to max end across multiple events", () => {
    const vp = autoViewportFromEvents([
      { start: { year: 100 }, end: { year: 200 } },
      { start: { year: 50 }, end: { year: 75 } },
      { start: { year: 150 }, end: { year: 300 } },
    ]);
    expect(vp).toEqual({ start: { year: 50 }, end: { year: 300 } });
  });

  it("respects month/day precision when years match", () => {
    const vp = autoViewportFromEvents([
      { start: { year: 100, month: 6 }, end: { year: 100, month: 9 } },
      { start: { year: 100, month: 3 }, end: { year: 100, month: 12 } },
    ]);
    expect(vp?.start.month).toBe(3);
    expect(vp?.end.month).toBe(12);
  });

  it("handles BCE (negative) years correctly", () => {
    const vp = autoViewportFromEvents([
      { start: { year: -1000 }, end: { year: -800 } },
      { start: { year: -1500 }, end: { year: -1200 } },
    ]);
    expect(vp).toEqual({ start: { year: -1500 }, end: { year: -800 } });
  });
});
