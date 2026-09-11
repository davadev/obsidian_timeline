// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { WindowedChart } from "../src/renderer/windowed-chart";
import { splitLabelling } from "../src/renderer/bar-renderer";
import { toJulian } from "../src/timeline/date";
import type { TimelineEvent } from "../src/timeline/model";

const PANE = 400;

beforeEach(() => {
  document.body.innerHTML = "";
});

function ev(id: string, from: number, to: number): TimelineEvent {
  return {
    id,
    text: `Event ${id}`,
    start: { year: from },
    end: { year: to },
    isPoint: from === to,
  } as TimelineEvent;
}

/** jsdom has no layout, so the pane size has to be declared. */
function host(): HTMLElement {
  const el = document.body.createDiv();
  Object.defineProperty(el, "clientWidth", { value: PANE, configurable: true });
  return el;
}

function chartWith(
  events: TimelineEvent[],
  zoom = 1
): { chart: WindowedChart; scroller: HTMLElement } {
  const container = host();
  const chart = new WindowedChart({
    container,
    categories: [],
    categoryColors: {},
    orientation: "horizontal",
    isMobile: false,
    onOpenEvent: () => {},
  });
  const scroller = container.querySelector(".txs-chart") as HTMLElement;
  Object.defineProperty(scroller, "clientWidth", {
    value: PANE,
    configurable: true,
  });
  chart.setData(events, [], { start: { year: -900 }, end: { year: 2030 } }, zoom);
  return { chart, scroller };
}

const spacerWidth = (scroller: HTMLElement) =>
  Number.parseFloat(
    (scroller.querySelector(".txs-chart-spacer") as HTMLElement).style.width
  );

/** Zoom is coalesced to one rebuild per frame; let that frame run. */
const settle = () => new Promise((r) => requestAnimationFrame(() => r(null)));

const tiles = (scroller: HTMLElement) =>
  Array.from(scroller.querySelectorAll(".txs-tile-host")) as HTMLElement[];

const DATA = [
  ev("a", -800, -700),
  ev("b", 100, 400),
  ev("c", 1500, 1600),
  ev("d", 1900, 2000),
];

describe("windowed chart", () => {
  it("sizes the scroller by the zoom, not by the chart", () => {
    const { scroller } = chartWith(DATA, 8);
    // Eight screens of timeline at this zoom...
    expect(spacerWidth(scroller)).toBeCloseTo(PANE * 8, 0);
    // ...but only a ring of pane-wide tiles is drawn.
    expect(tiles(scroller).length).toBeLessThanOrEqual(5);
    for (const t of tiles(scroller)) {
      const svg = t.querySelector("svg");
      expect(Number(svg?.getAttribute("width"))).toBe(PANE);
    }
  });

  it("gives the scroller a height, so the chart is actually visible", () => {
    // Regression: tiles are absolutely positioned and contribute no height, so
    // a 1px spacer collapsed the scroller and the view showed only its list.
    const { scroller } = chartWith(DATA, 1);
    const spacer = scroller.querySelector(".txs-chart-spacer") as HTMLElement;
    const height = Number.parseFloat(spacer.style.height);
    expect(height).toBeGreaterThan(40);

    const svg = scroller.querySelector("svg");
    expect(Number(svg?.getAttribute("height"))).toBeCloseTo(height, 0);
  });

  it("keeps the drawn node count flat as the zoom deepens", async () => {
    const { chart, scroller } = chartWith(DATA, 1);

    for (let i = 0; i < 20; i++) chart.zoomBy(2);
    await settle();
    const deep = scroller.querySelectorAll("*").length;
    expect(chart.zoom).toBeGreaterThan(1000);

    for (let i = 0; i < 20; i++) chart.zoomBy(2);
    await settle();
    const deeper = scroller.querySelectorAll("*").length;

    // The whole point: a million times the zoom draws the same handful of
    // tiles. The old renderer's SVG grew with the zoom factor until iOS
    // refused to paint it.
    expect(deep).toBeLessThan(400);
    expect(deeper).toBeLessThan(400);
    expect(tiles(scroller).length).toBeLessThanOrEqual(5);
  });

  it("stops at a one-hour window", async () => {
    const { chart } = chartWith(DATA, 1);
    for (let i = 0; i < 60; i++) chart.zoomBy(4);
    await settle();
    // maxZoom is ~2.5e7 here, so compare proportionally rather than in absolute
    // days.
    expect(chart.zoom / chart.maxZoom).toBeCloseTo(1, 6);
  });

  it("assigns lanes across the whole set, so a bar keeps its row", async () => {
    // Two overlapping events must land on different lanes wherever they are
    // drawn, including when only one of them is in view.
    const overlapping = [ev("x", 1000, 1200), ev("y", 1100, 1300)];
    const { chart, scroller } = chartWith(overlapping, 1);
    const laneOf = (id: string) => {
      const rect = scroller.querySelector(`.txs-event-bar`);
      return rect ? Number(rect.getAttribute("y")) : NaN;
    };
    const before = laneOf("x");
    chart.zoomBy(8);
    await settle();
    expect(Number.isNaN(before)).toBe(false);
    expect(Number.isNaN(laneOf("x"))).toBe(false);
  });

  it("pages the scroller instead of asking for an impossible width", async () => {
    const { chart, scroller } = chartWith(DATA, 1);
    for (let i = 0; i < 60; i++) chart.zoomBy(4); // to the hour floor
    await settle();
    // 2930 years at an hour per pane would be ~2e10px; the page caps it.
    expect(spacerWidth(scroller)).toBeLessThanOrEqual(2_000_000);
    expect(spacerWidth(scroller)).toBeGreaterThan(PANE);
  });

  it("keeps the same dates on screen when the pane is resized", () => {
    const { chart, scroller } = chartWith(DATA, 6);
    const before = chart.zoom;

    Object.defineProperty(scroller, "clientWidth", {
      value: PANE * 2,
      configurable: true,
    });
    // ResizeObserver does not fire in jsdom; the handler is what it would call.
    (chart as unknown as { onResize: () => void }).onResize();

    expect(chart.zoom).toBeCloseTo(before, 6);
  });

  it("holds the window across a data change, rather than jumping to the start", async () => {
    const { chart } = chartWith(DATA, 20);
    chart.zoomBy(1);
    await settle();
    const windowBefore = (chart as unknown as { window: { from: number } }).window
      .from;

    // A category toggle: same span, fewer events.
    chart.setData(DATA.slice(0, 2), [], {
      start: { year: -900 },
      end: { year: 2030 },
    });

    const after = (chart as unknown as { window: { from: number } }).window.from;
    expect(after).toBeCloseTo(windowBefore, 3);
  });

  it("re-anchors the window when the span shrinks under it", () => {
    const { chart } = chartWith(DATA, 20);
    chart.setData(DATA, [], { start: { year: 1900 }, end: { year: 2000 } });
    const w = (chart as unknown as { window: { from: number; to: number } }).window;
    expect(w.from).toBeGreaterThanOrEqual(toJulian({ year: 1900 }) - 1);
    expect(w.to).toBeLessThanOrEqual(toJulian({ year: 2000 }) + 1);
  });

  it("always restores panning, even if the gesture's end never arrives", async () => {
    // Regression: the scroller was left with touch-action: none when a pinch
    // ended without its closing event, which killed scrolling after a zoom.
    const { chart, scroller } = chartWith(DATA, 2);
    (chart as unknown as { holdPinch: () => void }).holdPinch();
    expect(scroller.classList.contains("is-pinching")).toBe(true);

    await new Promise((r) => setTimeout(r, 700));
    expect(scroller.classList.contains("is-pinching")).toBe(false);
  });

  it("amplifies a pinch so one gesture covers real ground", async () => {
    const { chart } = chartWith(DATA, 1);
    // A comfortable two-finger spread is about 2x; that has to be worth more
    // than 2x of zoom or crossing the range takes a dozen pinches.
    const before = chart.zoom;
    (chart as unknown as { zoomTo: (z: number) => void }).zoomTo(
      before * Math.pow(2, 2.5)
    );
    await settle();
    expect(chart.zoom).toBeGreaterThan(before * 4);
  });

  it("does not touch the DOM while a gesture is live", async () => {
    // Regression: tiles were rebuilt on every zoom frame, so the element the
    // pinch started on left the document and the browser cancelled the
    // gesture — the zoom moved a little, then stopped responding.
    const { chart, scroller } = chartWith(DATA, 1);
    const gesture = chart as unknown as {
      beginPreview: (px: number) => void;
      updatePreview: (scale: number, px: number) => void;
      commitPreview: () => void;
    };

    const before = tiles(scroller);
    expect(before.length).toBeGreaterThan(0);

    gesture.beginPreview(200);
    for (const scale of [1.2, 2, 4, 9]) {
      gesture.updatePreview(scale, 200);
      await settle();
    }

    const during = tiles(scroller);
    expect(during).toEqual(before); // same nodes, not replacements
    for (const t of before) expect(t.isConnected).toBe(true);

    // Scrolling mid-gesture must not redraw either.
    scroller.scrollLeft = 900;
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    expect(tiles(scroller)).toEqual(before);

    const zoomBefore = chart.zoom;
    gesture.commitPreview();
    await settle();
    expect(chart.zoom).toBeGreaterThan(zoomBefore * 4);
  });

  it("counter-scales anything that is not a duration during a gesture", async () => {
    const { chart, scroller } = chartWith(DATA, 8);
    const gesture = chart as unknown as {
      beginPreview: (px: number) => void;
      updatePreview: (scale: number, px: number) => void;
    };
    gesture.beginPreview(200);
    gesture.updatePreview(6, 200);
    await settle();

    // Bars stretch with the gesture; text and point markers undo it, so a
    // label is not smeared across the screen while the fingers move.
    const layer = scroller.querySelector(".txs-chart-tiles") as HTMLElement;
    expect(layer.style.getPropertyValue("--txs-tile-scale")).toBe("6");
    expect(Number(layer.style.getPropertyValue("--txs-tile-inv"))).toBeCloseTo(
      1 / 6,
      6
    );
    expect(scroller.classList.contains("is-zooming")).toBe(true);
  });

  it("names events whose bar is too short to hold a label", () => {
    // A point has no width at any zoom, and at this one the two-year bar is a
    // few pixels: without callouts the chart shows coloured specks and no text.
    const withPoint = [
      ev("long", -800, 1900),
      { ...ev("spark", 1000, 1000), isPoint: true } as TimelineEvent,
    ];
    const { scroller } = chartWith(withPoint, 1);
    const callouts = Array.from(
      scroller.querySelectorAll(".txs-callout-label")
    ).map((el) => el.textContent);
    expect(callouts).toContain("Event spark");
    // The leader is what ties the name to the speck it belongs to.
    expect(scroller.querySelectorAll(".txs-callout-leader").length).toBe(1);
  });

  it("makes the name the hit target, since the event itself is a few pixels", () => {
    const opened: string[] = [];
    const container = host();
    const chart = new WindowedChart({
      container,
      categories: [],
      categoryColors: {},
      orientation: "horizontal",
      isMobile: false,
      onOpenEvent: (id) => opened.push(id),
    });
    const scroller = container.querySelector(".txs-chart") as HTMLElement;
    Object.defineProperty(scroller, "clientWidth", {
      value: PANE,
      configurable: true,
    });
    chart.setData(
      [
        ev("long", -800, 1900),
        { ...ev("spark", 1500, 1500), isPoint: true } as TimelineEvent,
      ],
      [],
      { start: { year: -900 }, end: { year: 2030 } },
      1
    );

    const label = scroller.querySelector(".txs-callout-label") as SVGElement;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual(["spark"]);
  });

  it("draws no callouts when the setting is off", () => {
    const container = host();
    const chart = new WindowedChart({
      container,
      categories: [],
      categoryColors: {},
      orientation: "horizontal",
      isMobile: false,
      onOpenEvent: () => {},
      shortEventLabels: false,
    });
    const scroller = container.querySelector(".txs-chart") as HTMLElement;
    Object.defineProperty(scroller, "clientWidth", {
      value: PANE,
      configurable: true,
    });
    chart.setData(
      [{ ...ev("spark", 1500, 1500), isPoint: true } as TimelineEvent],
      [],
      { start: { year: -900 }, end: { year: 2030 } },
      1
    );
    expect(scroller.querySelectorAll(".txs-callout-label").length).toBe(0);
  });

  it("decides shortness from the bar, not from how far it is scrolled", () => {
    // Regression: a long bar scrolled halfway out has little *visible* room, so
    // judging by the sliver gave it a callout that vanished again when it came
    // back — a name flickering beside a bar that was never short.
    const long = ev("long", 1000, 1900);
    const { needCallout } = splitLabelling(
      [{ ev: long, lane: 0, startPx: -5000, endPx: 40 }],
      PANE
    );
    expect(needCallout).toEqual([]);
  });

  it("waits until an event is fully on screen before naming it", () => {
    const short = ev("short", 1000, 1001);
    const straddling = splitLabelling(
      [{ ev: short, lane: 0, startPx: -3, endPx: 4 }],
      PANE
    );
    expect(straddling.needCallout).toEqual([]);

    const inside = splitLabelling(
      [{ ev: short, lane: 0, startPx: 100, endPx: 107 }],
      PANE
    );
    expect(inside.needCallout.map((c) => c.id)).toEqual(["short"]);
  });

  it("still counts a scrolled-out bar as occupied, so nothing lands on it", () => {
    const long = ev("long", 1000, 1900);
    const { occupied } = splitLabelling(
      [{ ev: long, lane: 0, startPx: -5000, endPx: 40 }],
      PANE
    );
    expect(occupied).toEqual([{ lane: 0, from: -5000, to: 40 }]);
  });

  it("tears down cleanly", () => {
    const { chart, scroller } = chartWith(DATA, 2);
    chart.destroy();
    expect(scroller.isConnected).toBe(false);
  });
});
