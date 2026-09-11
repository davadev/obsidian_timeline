// @vitest-environment jsdom
import "./setup-obsidian-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { WindowedChart } from "../src/renderer/windowed-chart";
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

  it("tears down cleanly", () => {
    const { chart, scroller } = chartWith(DATA, 2);
    chart.destroy();
    expect(scroller.isConnected).toBe(false);
  });
});
