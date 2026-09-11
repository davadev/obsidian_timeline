import { describe, expect, it } from "vitest";
import { toJulian } from "../src/timeline/date";
import {
  MAX_SCROLL_PX,
  MIN_WINDOW_DAYS,
  clampWindow,
  clampZoomFor,
  maxZoomFor,
  needsRepage,
  pageFor,
  scrollToWindow,
  spanOf,
  tileAt,
  tileRange,
  windowDates,
  windowDays,
  windowFor,
  windowToScroll,
  zoomOf,
} from "../src/renderer/time-window";

const SPAN = spanOf({ year: -900 }, { year: 2030 }); // ~2930 years
const PANE = 390; // a phone

describe("zoom and window", () => {
  it("keeps the old meaning of zoom: full span over what is visible", () => {
    const w = windowFor(4, (SPAN.from + SPAN.to) / 2, SPAN);
    expect(zoomOf(w, SPAN)).toBeCloseTo(4, 6);
    expect(windowDays(w)).toBeCloseTo((SPAN.to - SPAN.from) / 4, 3);
  });

  it("zoom 1 shows everything, and cannot go wider", () => {
    const w = windowFor(1, SPAN.from, SPAN);
    expect(w.from).toBeCloseTo(SPAN.from, 6);
    expect(w.to).toBeCloseTo(SPAN.to, 6);
    expect(clampZoomFor(0.2, SPAN)).toBe(1);
  });

  it("stops at a one-hour window", () => {
    const deepest = windowFor(maxZoomFor(SPAN) * 10, 0, SPAN);
    expect(windowDays(deepest)).toBeCloseTo(MIN_WINDOW_DAYS, 9);
  });

  it("pushes a window back inside the span instead of hanging off an edge", () => {
    const atEnd = windowFor(10, SPAN.to + 500, SPAN);
    expect(atEnd.to).toBeCloseTo(SPAN.to, 6);
    expect(atEnd.from).toBeGreaterThan(SPAN.from);

    const atStart = windowFor(10, SPAN.from - 500, SPAN);
    expect(atStart.from).toBeCloseTo(SPAN.from, 6);
  });

  it("re-anchors a window when the span shrinks under it", () => {
    // What a category toggle does: fewer events, narrower span.
    const narrow = spanOf({ year: 1900 }, { year: 2000 });
    const w = windowFor(20, toJulian({ year: 1500 }), SPAN);
    const clamped = clampWindow(w, narrow);
    expect(clamped.from).toBeGreaterThanOrEqual(narrow.from);
    expect(clamped.to).toBeLessThanOrEqual(narrow.to + 1e-6);
  });

  it("reports dates for the window, including time of day at depth", () => {
    const day = windowFor(maxZoomFor(SPAN) / 24, toJulian({ year: 1969, month: 7, day: 20 }), SPAN);
    const { start } = windowDates(day);
    expect(start.year).toBe(1969);
    expect(start.month).toBe(7);
    expect(typeof start.hour).toBe("number");
  });
});

describe("scroller mapping", () => {
  it("round-trips window -> scroll -> window", () => {
    const w = windowFor(50, toJulian({ year: 1200 }), SPAN);
    const page = pageFor(w, SPAN, PANE);
    const scroll = windowToScroll(w, page, PANE);
    const back = scrollToWindow(scroll, page, PANE, windowDays(w));
    expect(back.from).toBeCloseTo(w.from, 3);
    expect(windowDays(back)).toBeCloseTo(windowDays(w), 6);
  });

  it("puts the start of the span at scroll 0 and the end at the far edge", () => {
    const w = windowFor(20, SPAN.from, SPAN);
    const page = pageFor(w, SPAN, PANE);
    expect(windowToScroll(w, page, PANE)).toBe(0);

    const last = windowFor(20, SPAN.to, SPAN);
    expect(windowToScroll(last, page, PANE)).toBeCloseTo(page.px - PANE, 0);
  });

  it("scrolling right moves forward in time", () => {
    const w = windowFor(20, (SPAN.from + SPAN.to) / 2, SPAN);
    const page = pageFor(w, SPAN, PANE);
    const a = scrollToWindow(1000, page, PANE, windowDays(w));
    const b = scrollToWindow(2000, page, PANE, windowDays(w));
    expect(b.from).toBeGreaterThan(a.from);
  });
});

describe("paging", () => {
  it("represents the whole span while it fits the pixel budget", () => {
    const w = windowFor(100, 0, SPAN);
    const page = pageFor(w, SPAN, PANE);
    expect(page.px).toBeLessThanOrEqual(MAX_SCROLL_PX);
    expect(page.from).toBeCloseTo(SPAN.from, 6);
    expect(page.to).toBeCloseTo(SPAN.to, 6);
  });

  it("falls back to a slice once the whole span would not fit", () => {
    // An hour-deep window on this span would want ~2e10 px.
    const deep = windowFor(maxZoomFor(SPAN), toJulian({ year: 1000 }), SPAN);
    const page = pageFor(deep, SPAN, PANE);
    expect(page.px).toBe(MAX_SCROLL_PX);
    expect(page.to - page.from).toBeLessThan(SPAN.to - SPAN.from);
    // and it contains the window it was built for
    expect(page.from).toBeLessThanOrEqual(deep.from);
    expect(page.to).toBeGreaterThanOrEqual(deep.to);
  });

  it("asks for a re-anchor only near the edge of a partial page", () => {
    const deep = windowFor(maxZoomFor(SPAN), toJulian({ year: 1000 }), SPAN);
    const page = pageFor(deep, SPAN, PANE);
    const usable = page.px - PANE;

    expect(needsRepage(usable / 2, page, SPAN, PANE)).toBe(false);
    expect(needsRepage(0, page, SPAN, PANE)).toBe(true);
    expect(needsRepage(usable, page, SPAN, PANE)).toBe(true);
  });

  it("never asks to re-anchor a page that already covers everything", () => {
    const w = windowFor(2, 0, SPAN);
    const page = pageFor(w, SPAN, PANE);
    expect(needsRepage(0, page, SPAN, PANE)).toBe(false);
    expect(needsRepage(page.px - PANE, page, SPAN, PANE)).toBe(false);
  });

  it("keeps the dates under the viewport when a page is re-anchored", () => {
    const w = windowFor(maxZoomFor(SPAN) / 2, toJulian({ year: 1000 }), SPAN);
    const oldPage = pageFor(w, SPAN, PANE);
    const scroll = windowToScroll(w, oldPage, PANE);
    const shown = scrollToWindow(scroll, oldPage, PANE, windowDays(w));

    // Re-anchor around what is on screen, then ask where that window now sits.
    const newPage = pageFor(shown, SPAN, PANE);
    const newScroll = windowToScroll(shown, newPage, PANE);
    const after = scrollToWindow(newScroll, newPage, PANE, windowDays(shown));

    expect(after.from).toBeCloseTo(shown.from, 2);
  });
});

describe("tiles", () => {
  it("covers the scroll position with a ring of neighbours", () => {
    const w = windowFor(30, (SPAN.from + SPAN.to) / 2, SPAN);
    const page = pageFor(w, SPAN, PANE);
    const scroll = windowToScroll(w, page, PANE);
    const ring = tileRange(scroll, page, PANE, 2);

    expect(ring.length).toBe(5);
    const visible = Math.floor(scroll / PANE);
    expect(ring).toContain(visible);
    // contiguous
    for (let i = 1; i < ring.length; i++) {
      expect(ring[i] - ring[i - 1]).toBe(1);
    }
  });

  it("clips the ring at the ends instead of inventing tiles", () => {
    const w = windowFor(30, SPAN.from, SPAN);
    const page = pageFor(w, SPAN, PANE);
    const ring = tileRange(0, page, PANE, 2);
    expect(Math.min(...ring)).toBe(0);
    expect(ring.length).toBeLessThanOrEqual(5);
  });

  it("lays tiles end to end in both px and time", () => {
    const w = windowFor(30, 0, SPAN);
    const page = pageFor(w, SPAN, PANE);
    const a = tileAt(4, page, PANE);
    const b = tileAt(5, page, PANE);

    expect(b.px - a.px).toBe(PANE);
    expect(a.to).toBeCloseTo(b.from, 9);
    expect(b.from).toBeGreaterThan(a.from);
  });

  it("puts a tile where the scroll says it should be", () => {
    const w = windowFor(30, toJulian({ year: 800 }), SPAN);
    const page = pageFor(w, SPAN, PANE);
    const scroll = windowToScroll(w, page, PANE);
    const tile = tileAt(Math.floor(scroll / PANE), page, PANE);

    // the tile the user is looking at starts no later than the window does
    expect(tile.from).toBeLessThanOrEqual(w.from + 1e-6);
    expect(tile.to).toBeGreaterThan(w.from);
  });
});
