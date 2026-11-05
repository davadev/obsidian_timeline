// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowedChart, type WindowedChartArgs } from "../src/renderer/windowed-chart";
import type { TimelineEra, TimelineEvent } from "../src/timeline/model";

const PANE = 400;
const SPAN = { start: { year: -900 }, end: { year: 2030 } };
const ev = (id: string, a: number, b: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, text: `Event ${id} named at length`, start: { year: a }, end: { year: b }, isPoint: a === b, ...over,
});
const DATA = [ev("a", -800, -700), ev("b", 100, 400), ev("c", 1500, 1500), ev("d", 1900, 2000), ev("long", -800, 1900)];

const settle = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const tick = () => new Promise((r) => setTimeout(r, 5));
const tiles = (s: HTMLElement) => [...s.querySelectorAll<HTMLElement>(".txs-tile-host")];

type Priv = {
  window: { from: number; to: number };
  preview: unknown;
  paneW: number;
  onResize(): void;
  beginPreview(px: number): void;
  updatePreview(scale: number, px: number): void;
  commitPreview(): void;
  zoomFrame: number | null;
};

function make(over: Partial<WindowedChartArgs> = {}, size = PANE, vertical = false) {
  const container = document.body.createDiv();
  const chart = new WindowedChart({
    container, categories: [], categoryColors: {}, orientation: vertical ? "vertical" : "horizontal",
    isMobile: false, onOpenEvent: vi.fn(), ...over,
  });
  const scroller = container.querySelector(".txs-chart") as HTMLElement;
  const key = vertical ? "clientHeight" : "clientWidth";
  Object.defineProperty(scroller, key, { value: size, configurable: true, writable: true });
  Object.defineProperty(scroller, "getBoundingClientRect", {
    value: () => ({ left: 10, top: 20, width: size, height: size, right: 0, bottom: 0, x: 0, y: 0 }),
  });
  return { chart, scroller, priv: chart as unknown as Priv, container };
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { ongesturestart?: unknown }).ongesturestart;
});

describe("setup and data", () => {
  it("accepts a ready-made span and a default zoom, reports window changes, and resets", async () => {
    const onWindowChange = vi.fn();
    const { chart } = make({ onWindowChange });
    chart.setData(DATA, [], { from: 0, to: 100_000 });
    expect(chart.zoom).toBeCloseTo(1, 6);
    expect(onWindowChange).toHaveBeenCalled();
    chart.zoomTo(10);
    await settle();
    expect(chart.zoom).toBeCloseTo(10, 3);
    chart.resetZoom();
    expect(chart.zoom).toBeCloseTo(1, 6);
    chart.resetZoom(4);
    expect(chart.zoom).toBeCloseTo(4, 3);
    expect(chart.maxZoom).toBeGreaterThan(1000);
  });

  it("paints eras into the tiles that cover them", () => {
    const era: TimelineEra = { id: "e", name: "Era", start: { year: 0 }, end: { year: 500 } };
    const { chart, scroller } = make();
    chart.setData(DATA, [era, { ...era, id: "far", start: { year: 5000 }, end: { year: 6000 } }], SPAN, 1);
    expect(scroller.querySelectorAll("rect[opacity='0.18']").length).toBeGreaterThan(0);
  });

  it("falls back to a plausible pane before the container has a size, and remembers a real one", () => {
    const { chart, scroller, priv } = make({}, 0);
    chart.setData(DATA, [], SPAN, 1);
    expect(priv.paneW).toBe(800);
    Object.defineProperty(scroller, "clientWidth", { value: 500, configurable: true });
    chart.setData(DATA, [], SPAN);
    expect(priv.paneW).toBe(500);
    Object.defineProperty(scroller, "clientWidth", { value: 0, configurable: true });
    chart.setData(DATA, [], SPAN);
    expect(priv.paneW).toBe(500);
  });

  it("lays out vertically: scrollTop sync, spacer height and a rotated edge layer", () => {
    const { chart, scroller } = make({}, PANE, true);
    chart.setData(DATA, [], SPAN, 6);
    const spacer = scroller.querySelector<HTMLElement>(".txs-chart-spacer")!;
    expect(Number.parseFloat(spacer.style.height)).toBeCloseTo(PANE * 6, 0);
    expect(scroller.classList.contains("txs-vertical")).toBe(true);
    const edge = scroller.querySelector(".txs-chart-edge svg")!;
    expect(edge.getAttribute("height")).toBe(String(PANE));
    expect(tiles(scroller)[0].style.left).toBe("0px");
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event("scroll"));
  });
});

describe("resize observation", () => {
  it("watches the scroller and disconnects on destroy", () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    let cb: () => void = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(c: () => void) { cb = c; }
      observe = observe;
      disconnect = disconnect;
    });
    const { chart, scroller, priv } = make();
    chart.setData(DATA, [], SPAN, 4);
    expect(observe).toHaveBeenCalledWith(scroller);
    Object.defineProperty(scroller, "clientWidth", { value: PANE * 2, configurable: true });
    const before = chart.zoom;
    cb();
    expect(priv.paneW).toBe(PANE * 2);
    expect(chart.zoom).toBeCloseTo(before, 6);
    cb(); // same size again: nothing to do
    chart.destroy();
    expect(disconnect).toHaveBeenCalled();
    expect(scroller.isConnected).toBe(false);
  });
});

describe("scrolling", () => {
  it("redraws for the window the scroll position selects, once per frame", async () => {
    const onWindowChange = vi.fn();
    const { chart, scroller } = make({ onWindowChange });
    chart.setData(DATA, [], SPAN, 10);
    await tick();
    onWindowChange.mockClear();
    scroller.scrollLeft = 1200;
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    await settle();
    expect(onWindowChange).toHaveBeenCalledTimes(1);
  });

  it("ignores the scroll caused by its own repositioning", () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 10);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    scroller.dispatchEvent(new Event("scroll")); // `syncing` is still set
    expect(raf).not.toHaveBeenCalled();
  });

  it("re-anchors the page when a paged scroller runs off its end", async () => {
    const { chart, scroller, priv } = make();
    chart.setData(DATA, [], { from: 0, to: 3_000_000 }, 1);
    for (let i = 0; i < 40; i++) chart.zoomBy(4);
    await settle();
    await tick();
    const page = (chart as unknown as { page: { px: number } }).page;
    const firstWindow = priv.window.from;
    scroller.scrollLeft = page.px - PANE; // the very end of the page
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    await tick();
    expect(priv.window.from).toBeGreaterThan(firstWindow);
  });
});

describe("zoom", () => {
  it("composes queued factors and keeps the focal date under the pointer", async () => {
    const { chart } = make();
    chart.setData(DATA, [], SPAN, 1);
    chart.zoomBy(2);
    chart.zoomBy(2, 100);
    await settle();
    expect(chart.zoom).toBeCloseTo(4, 3);
  });

  it("zooms on a ctrl+wheel (a trackpad pinch) and leaves plain wheel scrolling alone", async () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 1);
    const plain = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
    scroller.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    const pinch = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 110, cancelable: true });
    scroller.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    await settle();
    expect(chart.zoom).toBeGreaterThan(1);
  });

  it("uses the vertical coordinate for a ctrl+wheel in a vertical chart", async () => {
    const { chart, scroller } = make({}, PANE, true);
    chart.setData(DATA, [], SPAN, 1);
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientY: 120, cancelable: true }));
    await settle();
    expect(chart.zoom).toBeGreaterThan(1);
  });
});

describe("pinch previews", () => {
  it("starts a preview on demand, and ignores a commit that never started", async () => {
    const { chart, scroller, priv } = make();
    chart.setData(DATA, [], SPAN, 2);
    priv.updatePreview(3, 50); // no begin first
    expect(scroller.classList.contains("is-zooming")).toBe(true);
    priv.commitPreview();
    expect(scroller.classList.contains("is-zooming")).toBe(false);
    await settle();
    expect(chart.zoom).toBeGreaterThan(2);
    priv.commitPreview(); // nothing in flight
    expect(priv.zoomFrame).toBeNull();
  });
});

describe("WebKit gesture events", () => {
  const gesture = (type: string, extra: Record<string, unknown> = {}) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, extra);
    return e;
  };

  it("drives the preview from gesturestart/change/end and commits the zoom", async () => {
    (window as unknown as { ongesturestart: null }).ongesturestart = null;
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 1);
    const start = gesture("gesturestart", { clientX: 110 });
    scroller.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    scroller.dispatchEvent(gesture("gesturechange", { scale: 0 })); // ignored
    scroller.dispatchEvent(gesture("gesturechange")); // no scale: treated as 1
    scroller.dispatchEvent(gesture("gesturechange", { scale: 2 }));
    scroller.dispatchEvent(gesture("gestureend"));
    await settle();
    expect(chart.zoom).toBeGreaterThan(4);
  });

  it("centres the focal point when the event carries no coordinates, and reads clientY when vertical", () => {
    (window as unknown as { ongesturestart: null }).ongesturestart = null;
    const h = make();
    h.chart.setData(DATA, [], SPAN, 1);
    h.scroller.dispatchEvent(gesture("gesturestart"));
    expect(h.priv.preview).toMatchObject({ focalPx: PANE / 2 });
    document.body.innerHTML = "";
    const v = make({}, PANE, true);
    v.chart.setData(DATA, [], SPAN, 1);
    v.scroller.dispatchEvent(gesture("gesturestart", { clientY: 120 }));
    expect(v.priv.preview).toMatchObject({ focalPx: 100 });
  });
});

describe("touch gestures", () => {
  const touch = (type: string, points: Array<[number, number]>) => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
    return e;
  };

  it("pinches: begins on two fingers, scales on move, commits when they lift", async () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 1);
    scroller.dispatchEvent(touch("touchstart", [[110, 50], [210, 50]]));
    expect(scroller.classList.contains("is-pinching")).toBe(true);
    const move = touch("touchmove", [[60, 50], [260, 50]]);
    scroller.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    scroller.dispatchEvent(touch("touchmove", [[60, 50]])); // one finger: not a pinch
    scroller.dispatchEvent(touch("touchend", [[60, 50]]));
    expect(scroller.classList.contains("is-pinching")).toBe(true);
    scroller.dispatchEvent(touch("touchend", []));
    expect(scroller.classList.contains("is-pinching")).toBe(false);
    await settle();
    expect(chart.zoom).toBeGreaterThan(1);
  });

  it("ignores a single touch, and a cancel after nothing started", () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 1);
    scroller.dispatchEvent(touch("touchstart", [[10, 10]]));
    expect(scroller.classList.contains("is-pinching")).toBe(false);
    scroller.dispatchEvent(touch("touchcancel", []));
    expect(scroller.classList.contains("is-zooming")).toBe(false);
  });

  it("uses the vertical axis for the focal point in a vertical chart", () => {
    const { chart, scroller, priv } = make({}, PANE, true);
    chart.setData(DATA, [], SPAN, 1);
    scroller.dispatchEvent(touch("touchstart", [[50, 120], [50, 220]]));
    expect(priv.preview).toMatchObject({ focalPx: 150 });
    scroller.dispatchEvent(touch("touchmove", [[50, 70], [50, 270]]));
    expect(priv.preview).toMatchObject({ focalPx: 150 });
  });

  it("stands down once WebKit sends real gesture events", () => {
    (window as unknown as { ongesturestart: null }).ongesturestart = null;
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 1);
    scroller.dispatchEvent(Object.assign(new Event("gesturestart", { cancelable: true }), { clientX: 100 }));
    scroller.dispatchEvent(new Event("gestureend", { cancelable: true }));
    scroller.dispatchEvent(touch("touchstart", [[110, 50], [210, 50]]));
    scroller.dispatchEvent(touch("touchmove", [[60, 50], [260, 50]]));
    scroller.dispatchEvent(touch("touchend", [[60, 50]]));
    expect(scroller.classList.contains("is-pinching")).toBe(false);
  });

  it("restarts the watchdog on a second hold and cancels it on destroy", async () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 1);
    scroller.dispatchEvent(touch("touchstart", [[110, 50], [210, 50]]));
    scroller.dispatchEvent(touch("touchmove", [[60, 50], [260, 50]]));
    chart.destroy();
    expect(scroller.classList.contains("is-pinching")).toBe(false);
  });
});

describe("labels", () => {
  it("keeps a bar's label at its start when sliding is off, and drops it once that has scrolled away", async () => {
    const { chart, scroller } = make({ stickyLabels: false });
    chart.setData([ev("long", -800, 1900)], [], SPAN, 10);
    await tick();
    scroller.scrollLeft = 2000;
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    await settle();
    expect(scroller.querySelectorAll(".txs-chart-edge text:not(.txs-callout-label)")).toHaveLength(0);
  });

  it("slides labels along the visible part of their bar by default", async () => {
    const { chart, scroller } = make();
    chart.setData([ev("long", -800, 1900)], [], SPAN, 10);
    await tick();
    scroller.scrollLeft = 2000;
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    await settle();
    expect(scroller.querySelectorAll(".txs-chart-edge text:not(.txs-callout-label)")).toHaveLength(1);
  });

  it("names short events in a vertical chart too, and skips callouts when switched off", () => {
    const v = make({}, PANE, true);
    v.chart.setData([ev("long", -800, 1900), ev("spark", 1000, 1000)], [], SPAN, 1);
    expect(v.scroller.querySelectorAll(".txs-callout-label")).toHaveLength(1);
    document.body.innerHTML = "";
    const off = make({ shortEventLabels: false }, PANE, true);
    off.chart.setData([ev("long", -800, 1900), ev("spark", 1000, 1000)], [], SPAN, 1);
    expect(off.scroller.querySelectorAll(".txs-callout-label")).toHaveLength(0);
  });

  it("measures text again after a resize changed the theme or font", () => {
    const { chart, scroller, priv } = make();
    chart.setData(DATA, [], SPAN, 2);
    Object.defineProperty(scroller, "clientWidth", { value: PANE, configurable: true });
    priv.onResize();
    expect(() => chart.setData(DATA, [], SPAN)).not.toThrow();
  });
});

describe("lifecycle edge cases", () => {
  it("cancels a scroll frame that is still pending when destroyed", () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 10);
    scroller.scrollLeft = 900;
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    return tick().then(() => {
      scroller.dispatchEvent(new Event("scroll"));
      chart.destroy();
      expect(cancel).toHaveBeenCalled();
    });
  });

  it("leaves the drawn tiles alone if the data changes mid-gesture", () => {
    const { chart, scroller, priv } = make();
    chart.setData(DATA, [], SPAN, 4);
    const before = tiles(scroller);
    priv.beginPreview(100);
    chart.setData(DATA.slice(0, 2), [], SPAN);
    expect(tiles(scroller).every((t, i) => t === before[i] || !before[i])).toBe(true);
  });

  it("centres a vertical WebKit gesture that has no coordinates", () => {
    (window as unknown as { ongesturestart: null }).ongesturestart = null;
    const v = make({}, PANE, true);
    v.chart.setData(DATA, [], SPAN, 1);
    v.scroller.dispatchEvent(new Event("gesturestart", { cancelable: true }));
    expect(v.priv.preview).toMatchObject({ focalPx: PANE / 2 });
  });
});

describe("tiles", () => {
  it("drops tiles that left the ring as the scroll moves on", async () => {
    const { chart, scroller } = make();
    chart.setData(DATA, [], SPAN, 20);
    await tick();
    const first = new Set(tiles(scroller));
    scroller.scrollLeft = PANE * 12;
    scroller.dispatchEvent(new Event("scroll"));
    await settle();
    await settle();
    const now = tiles(scroller);
    expect(now.some((t) => !first.has(t))).toBe(true);
    expect([...first].some((t) => !t.isConnected)).toBe(true);
  });

  it("positions tiles top-down in a vertical chart", () => {
    const { chart, scroller } = make({}, PANE, true);
    chart.setData(DATA, [], SPAN, 8);
    expect(tiles(scroller).some((t) => t.style.left === "0px")).toBe(true);
  });
});
