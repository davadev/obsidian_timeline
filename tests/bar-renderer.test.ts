// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawCallout, drawViewportLabel, renderBar, splitLabelling, crossAxisSizeFor } from "../src/renderer/bar-renderer";
import type { BarRenderArgs } from "../src/renderer/bar-renderer";
import { hideTooltip } from "../src/renderer/tooltip";
import type { TimelineEra, TimelineEvent } from "../src/timeline/model";

const SVG = "http://www.w3.org/2000/svg";
const d = (year: number, month?: number, day?: number) => ({ year, month, day });
const ev = (id: string, a: number, b: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, text: `Event ${id} with a long name`, start: d(a), end: d(b), isPoint: a === b, ...over,
});
const viewport = { start: d(0), end: d(1000) };

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "";
  container = document.body.appendChild(document.createElement("div"));
  Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
});
afterEach(() => {
  hideTooltip();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = (over: Partial<BarRenderArgs> = {}) =>
  renderBar({
    container, events: [], categories: [], viewport, categoryColors: {}, onOpenEvent: vi.fn(), zoom: 1,
    orientation: "horizontal", isMobile: false, ...over,
  });
const svgOf = (w: HTMLElement) => w.querySelector("svg")!;
const q = (w: Element, sel: string) => [...w.querySelectorAll<SVGElement>(sel)];

describe("renderBar: empty and sizing", () => {
  it("says so when there is no viewport, or no events outside tile mode", () => {
    expect(render({ viewport: undefined, events: [ev("a", 1, 2)] }).textContent).toBe("No events to display.");
    expect(render({ events: [] }).textContent).toBe("No events to display.");
  });

  it("sizes the SVG from the container, zoom and lane count", () => {
    const w = render({ events: [ev("a", 100, 900)], zoom: 2 });
    expect(svgOf(w).getAttribute("width")).toBe("1600");
    expect(svgOf(w).getAttribute("height")).toBe(String(crossAxisSizeFor(1)));
    expect(w.classList.contains("txs-vertical")).toBe(false);
  });

  it("falls back to default container sizes when the container has no layout", () => {
    const bare = document.body.appendChild(document.createElement("div"));
    const h = renderBar({ container: bare, events: [ev("a", 1, 9)], categories: [], viewport, categoryColors: {}, onOpenEvent: vi.fn(), zoom: 1, orientation: "horizontal", isMobile: false });
    expect(svgOf(h).getAttribute("width")).toBe("800");
    const v = renderBar({ container: bare, events: [ev("a", 1, 9)], categories: [], viewport, categoryColors: {}, onOpenEvent: vi.fn(), zoom: 1, orientation: "vertical", isMobile: false });
    expect(svgOf(v).getAttribute("height")).toBe("600");
    expect(svgOf(v).getAttribute("width")).toBe(String(crossAxisSizeFor(1)));
  });

  it("flips axes for vertical orientation", () => {
    const w = render({ orientation: "vertical", events: [ev("a", 100, 900), ev("b", 100, 900)] });
    expect(w.classList.contains("txs-vertical")).toBe(true);
    expect(svgOf(w).getAttribute("height")).toBe("600");
    expect(Number(svgOf(w).getAttribute("width"))).toBeGreaterThan(crossAxisSizeFor(1));
  });

  it("caps the axis on mobile", () => {
    const w = render({ events: [ev("a", 1, 9)], zoom: 1000, isMobile: true });
    expect(Number(svgOf(w).getAttribute("width"))).toBeLessThanOrEqual(120000);
  });
});

describe("renderBar: events", () => {
  it("draws bars, points and labels, with long names truncated to the bar", () => {
    const w = render({ events: [ev("bar", 100, 400, { text: "A really quite remarkably long name for this one bar" }), ev("pt", 500, 500), ev("tiny", 600, 602)] });
    expect(q(w, "rect.txs-event-bar")).toHaveLength(2);
    expect(q(w, "circle.txs-event-point")).toHaveLength(1);
    const labels = q(w, "text.txs-event-label:not(.txs-callout-label)");
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent?.endsWith("…")).toBe(true);
    expect(q(w, "text.txs-callout-label").map((t) => t.textContent?.slice(0, 7))).toContain("Event p");
  });

  it("routes clicks to onOpenEvent without bubbling", () => {
    const onOpenEvent = vi.fn();
    const outer = vi.fn();
    container.addEventListener("click", outer);
    const w = render({ events: [ev("a", 100, 900), ev("p", 50, 50)], onOpenEvent });
    q(w, "rect.txs-event-bar")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    q(w, "circle.txs-event-point")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenEvent.mock.calls).toEqual([["a"], ["p"]]);
    expect(outer).not.toHaveBeenCalled();
  });

  it("shows a tooltip on hover on desktop, and none on mobile", () => {
    const w = render({ events: [ev("a", 100, 900)] });
    const bar = q(w, "rect.txs-event-bar")[0];
    bar.dispatchEvent(new MouseEvent("mouseenter", { clientX: 5, clientY: 6 }));
    expect(document.querySelector(".txs-tooltip")).not.toBeNull();
    hideTooltip();
    bar.dispatchEvent(new MouseEvent("mousemove", { clientX: 7, clientY: 8 }));
    expect(document.querySelector(".txs-tooltip")).not.toBeNull();
    bar.dispatchEvent(new MouseEvent("mouseleave"));
    expect(document.querySelector(".txs-tooltip")).toBeNull();
    document.body.innerHTML = "";
    container = document.body.appendChild(document.createElement("div"));
    const m = render({ events: [ev("a", 100, 900)], isMobile: true });
    q(m, "rect.txs-event-bar")[0].dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.querySelector(".txs-tooltip")).toBeNull();
  });

  it("colours by category palette, a hash for unknown categories, defaultColor, then the accent", () => {
    const w = render({
      categoryColors: { Known: "#112233" },
      events: [
        ev("1", 10, 90, { category: "Known" }), ev("2", 110, 190, { category: "Mystery" }),
        ev("3", 210, 290, { defaultColor: "200,10,10" }), ev("4", 310, 390, { defaultColor: "#abc" }),
        ev("5", 410, 490, { defaultColor: "nonsense" }), ev("6", 510, 590),
      ],
    });
    const fills = q(w, "rect.txs-event-bar").map((r) => r.getAttribute("fill"));
    expect(fills[0]).toBe("#112233");
    expect(fills[1]).toMatch(/^hsl\(\d+, 55%, 50%\)$/);
    expect(fills[2]).toBe("rgb(200,10,10)");
    expect(fills[3]).toBe("#abc");
    expect(fills[4]).toBe("var(--interactive-accent)");
    expect(fills[5]).toBe("var(--interactive-accent)");
  });

  it("picks label colours for light, dark, short-hex, rgb, hsl and unparseable fills, or an override", () => {
    const colours = (hex: string, over: Partial<BarRenderArgs> = {}) => {
      const w = render({ ...over, categoryColors: { C: hex }, events: [ev("a", 100, 900, { category: "C" })] });
      return q(w, "text.txs-event-label:not(.txs-callout-label)")[0].getAttribute("fill");
    };
    expect(colours("#ffffff")).toBe("#1a1a1a");
    expect(colours("#000000")).toBe("#ffffff");
    expect(colours("#fff")).toBe("#1a1a1a");
    expect(colours("rgb(250, 250, 250)")).toBe("#1a1a1a");
    expect(colours("hsl(60, 100%, 90%)")).toBe("#1a1a1a");
    expect(colours("hsla(240, 100%, 20%, 1)")).toBe("#ffffff");
    expect(colours("var(--x)")).toBe("#ffffff");
    expect(colours("#000000", { eventLabelColor: "  red " })).toBe("red");
    expect(colours("#000000", { eventLabelColor: "   " })).toBe("#ffffff");
  });

  it("applies fuzzy gradients to bars and points in every combination", () => {
    const w = render({
      events: [
        ev("s", 10, 200, { fuzzyStart: true }), ev("e", 210, 400, { fuzzyEnd: true }),
        ev("b", 410, 600, { fuzzyStart: true, fuzzyEnd: true }), ev("f", 610, 800, { fuzzy: true }),
        ev("fs", 810, 990, { fuzzy: true, fuzzyStart: false }), ev("p", 5, 5, { fuzzy: true }),
        ev("fe", 810, 990, { fuzzy: true, fuzzyEnd: false }), ev("none", 810, 990, { fuzzy: true, fuzzyStart: false, fuzzyEnd: false }),
        ev("plain", 300, 300),
      ],
    });
    const defs = q(w, "defs linearGradient");
    expect(defs).toHaveLength(6); // "none" opts both edges out, so it gets no gradient
    expect(q(w, "defs radialGradient")).toHaveLength(1);
    const stops = (g: Element) => [...g.querySelectorAll("stop")].map((s) => s.getAttribute("offset"));
    expect(stops(defs[0])).toEqual(["0%", "20%", "100%"]);
    expect(stops(defs[1])).toEqual(["0%", "80%", "100%"]);
    expect(stops(defs[2])).toEqual(["0%", "20%", "80%", "100%"]);
    expect(stops(defs[3])).toEqual(["0%", "20%", "80%", "100%"]); // fuzzy alone = both edges
    expect(stops(defs[4])).toEqual(["0%", "80%", "100%"]); // fuzzy, start opted out = end only
    expect(stops(defs[5])).toEqual(["0%", "20%", "100%"]); // fuzzy, end opted out = start only
    expect(q(w, "rect.txs-event-bar")[0].getAttribute("fill")).toMatch(/^url\(.*#txs-fuzzy-/);
    expect(q(w, "circle")[0].getAttribute("fill")).toMatch(/^url\(/);
    expect(q(w, "circle")[1].getAttribute("fill")).toBe("var(--interactive-accent)");
  });

  it("clamps the fuzzy fade percentage", () => {
    const fade = (p: number) => {
      const w = render({ fuzzyGradientPercent: p, events: [ev("s", 10, 200, { fuzzyStart: true })] });
      return q(w, "stop").map((s) => s.getAttribute("offset"))[1];
    };
    expect(fade(NaN)).toBe("20%");
    expect(fade(0)).toBe("1%");
    expect(fade(80)).toBe("49%");
    expect(fade(10)).toBe("10%");
  });

  it("draws vertical bars, points and gradients", () => {
    const w = render({
      orientation: "vertical",
      events: [ev("a", 100, 900, { fuzzyEnd: true }), ev("p", 500, 500), ev("t", 300, 302)],
    });
    const bar = q(w, "rect.txs-event-bar")[0];
    expect(bar.getAttribute("width")).toBe("26");
    expect(Number(bar.getAttribute("height"))).toBeGreaterThan(100);
    expect(q(w, "defs linearGradient")[0].getAttribute("y2")).toBe("1");
    expect(q(w, "text.txs-event-label:not(.txs-callout-label)")[0].getAttribute("text-anchor")).toBe("start");
    expect(q(w, "g").some((g) => g.getAttribute("transform")?.includes("rotate(90)"))).toBe(true);
    expect(q(w, "line.txs-callout-leader").length).toBeGreaterThan(0);
  });

  it("omits callouts when shortEventLabels is off, and in-bar labels' sliding when stickyLabels is off", () => {
    const w = render({ shortEventLabels: false, stickyLabels: false, events: [ev("p", 500, 500), ev("a", 100, 900)] });
    expect(q(w, "text.txs-callout-label")).toHaveLength(0);
  });
});

describe("renderBar: eras", () => {
  const era = (id: string, a: number, b: number, over: Partial<TimelineEra> = {}): TimelineEra => ({
    id, name: `Era ${id}`, start: d(a), end: d(b), ...over,
  });

  it("paints bands behind the events, skipping eras outside the viewport", () => {
    const w = render({ events: [ev("a", 100, 900)], eras: [era("in", 100, 500, { color: "10,20,30" }), era("out", 2000, 3000), era("before", -500, -100)] });
    const bands = q(w, "rect[opacity='0.18']");
    expect(bands).toHaveLength(1);
    expect(bands[0].getAttribute("fill")).toBe("rgb(10,20,30)");
    expect(bands[0].getAttribute("pointer-events")).toBe("none");
    expect(q(w, "text.txs-era-label")[0].textContent).toBe("Era in");
  });

  it("makes bands and labels clickable when a handler is supplied", () => {
    const onOpenEra = vi.fn();
    const outer = vi.fn();
    container.addEventListener("click", outer);
    const w = render({ events: [ev("a", 100, 900)], onOpenEra, eras: [era("x", 100, 500)] });
    q(w, "rect[opacity='0.18']")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    q(w, "text.txs-era-label")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenEra.mock.calls).toEqual([["x"], ["x"]]);
    expect(outer).not.toHaveBeenCalled();
  });

  it("hashes a colour for eras without one, or with an unusable one, and skips labels on thin or unnamed bands", () => {
    const w = render({
      events: [ev("a", 100, 900)],
      eras: [era("plain", 100, 400), era("bad", 410, 500, { color: "nonsense" }), era("thin", 600, 610), era("noname", 700, 900, { name: "" })],
    });
    const fills = q(w, "rect[opacity='0.18']").map((r) => r.getAttribute("fill"));
    expect(fills.every((f) => /^hsl\(/.test(f!))).toBe(true);
    expect(q(w, "text.txs-era-label").map((t) => t.textContent)).toEqual(["Era plain", "Era bad"]);
    expect(q(w, "text.txs-era-label")[0].getAttribute("fill")).toMatch(/^hsl\(/);
  });

  it("lays eras out vertically", () => {
    const w = render({ orientation: "vertical", events: [ev("a", 100, 900)], onOpenEra: vi.fn(), eras: [era("v", 100, 500)] });
    const band = q(w, "rect[opacity='0.18']")[0];
    expect(band.getAttribute("x")).toBe("0");
    const label = q(w, "text.txs-era-label")[0];
    expect(label.getAttribute("dominant-baseline")).toBe("middle");
  });
});

describe("renderBar: tile mode", () => {
  it("draws exactly the asked-for slice, takes lanes from the map, and never labels", () => {
    const w = renderBar({
      container, events: [ev("a", 100, 900), ev("b", 100, 900), ev("c", 100, 900), ev("p", 500, 500)], categories: [], viewport,
      categoryColors: {}, onOpenEvent: vi.fn(), zoom: 1, orientation: "horizontal", isMobile: false,
      tile: { axisPx: 400.4, laneByEventId: new Map([["a", 0], ["b", 2]]), laneCount: 0 },
    });
    expect(w.classList.contains("txs-tile")).toBe(true);
    expect(svgOf(w).getAttribute("width")).toBe("400");
    expect(q(w, "text.txs-event-label")).toHaveLength(0);
    expect(q(w, "rect.txs-event-bar")).toHaveLength(3);
    expect(q(w, "line.txs-axis-line")).toHaveLength(1);
  });

  it("renders an empty tile (no events) and an unclamped era without throwing", () => {
    const w = renderBar({
      container, events: [], categories: [], viewport, categoryColors: {}, onOpenEvent: vi.fn(), zoom: 1,
      orientation: "vertical", isMobile: false, eras: [{ id: "e", name: "E", start: d(-100), end: d(500) }],
      tile: { axisPx: 0, laneByEventId: new Map(), laneCount: 1 },
    });
    expect(svgOf(w).getAttribute("height")).toBe("1");
    expect(q(w, "rect[opacity='0.18']")).toHaveLength(1);
  });
});

describe("renderBar: scrolling behaviour", () => {
  const scrolled = (orientation: "horizontal" | "vertical") => {
    vi.useFakeTimers();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    (SVGElement.prototype as unknown as { getComputedTextLength: () => number }).getComputedTextLength = () => 30;
    const w = render({
      orientation,
      events: [ev("a", 0, 1000, { text: "A very long running event name" }), ev("b", 600, 700, { text: "Second event name here" })],
    });
    return { w, raf };
  };
  const setScroll = (w: HTMLElement, key: "scrollLeft" | "scrollTop", value: number, size = 200) => {
    Object.defineProperty(w, key, { value, configurable: true });
    Object.defineProperty(w, key === "scrollLeft" ? "clientWidth" : "clientHeight", { value: size, configurable: true });
  };
  afterEach(() => {
    delete (SVGElement.prototype as unknown as { getComputedTextLength?: () => number }).getComputedTextLength;
  });

  it("slides a label along its bar as the pane scrolls, repainting when the scroll settles", () => {
    const { w } = scrolled("horizontal");
    const label = () => q(w, "g").find((g) => g.querySelector("text.txs-event-label"))!;
    const before = label().getAttribute("transform");
    setScroll(w, "scrollLeft", 300);
    w.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(90);
    expect(label().getAttribute("transform")).not.toBe(before);
    expect(label().getAttribute("transform")).toMatch(/^translate\(\d/);
  });

  it("repaints at once when the scroll leaves the painted margin, and debounces small moves", () => {
    const { w, raf } = scrolled("horizontal");
    setScroll(w, "scrollLeft", 10);
    const calls = raf.mock.calls.length;
    w.dispatchEvent(new Event("scroll"));
    expect(raf.mock.calls.length).toBe(calls);
    setScroll(w, "scrollLeft", 900);
    w.dispatchEvent(new Event("scroll"));
    expect(raf.mock.calls.length).toBe(calls + 1);
    w.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(90);
  });

  it("works the same way vertically, and skips labels beyond the visible stretch", () => {
    const { w } = scrolled("vertical");
    setScroll(w, "scrollTop", 400);
    w.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(90);
    const transforms = q(w, "g").map((g) => g.getAttribute("transform")).filter(Boolean);
    expect(transforms.some((t) => t!.includes("rotate(90)"))).toBe(true);
  });

  it("copes with glyph widths it cannot measure", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => (cb(0), 0));
    (SVGElement.prototype as unknown as { getComputedTextLength: () => number }).getComputedTextLength = () => {
      throw new Error("no layout");
    };
    expect(() => render({ events: [ev("a", 0, 1000, { text: "Long enough name for a label" })] })).not.toThrow();
  });
});

describe("drawViewportLabel", () => {
  const svg = () => document.createElementNS(SVG, "svg");
  const base = { lane: 1, paneSize: 500, isVertical: false, categoryColors: {} };
  it("refuses a bar with too little visible room", () => {
    expect(drawViewportLabel(svg(), ev("a", 0, 0), { ...base, startPx: 480, endPx: 520 })).toBe(false);
  });
  it("labels the visible part of a bar that starts before the pane", () => {
    const s = svg();
    expect(drawViewportLabel(s, ev("a", 0, 0, { text: "Hello there world" }), { ...base, startPx: -100, endPx: 300, labelColorOverride: "red" })).toBe(true);
    expect(s.querySelector("text")?.getAttribute("fill")).toBe("red");
    expect(s.querySelector("g")?.getAttribute("transform")).toContain("translate(0 ");
  });
  it("rotates vertically", () => {
    const s = svg();
    drawViewportLabel(s, ev("a", 0, 0), { ...base, isVertical: true, startPx: 10, endPx: 400 });
    expect(s.querySelector("g")?.getAttribute("transform")).toContain("rotate(90)");
    expect(s.querySelector("text")?.getAttribute("text-anchor")).toBe("start");
  });
});

describe("drawCallout", () => {
  const callout = (side: "after" | "before") => ({ id: "a", lane: 0, textPx: 100, anchorPx: 50, side, label: "Name", widthPx: 30 });
  const run = (over: Partial<Parameters<typeof drawCallout>[3]> = {}, side: "after" | "before" = "after") => {
    const s = document.createElementNS(SVG, "svg");
    const onOpenEvent = vi.fn();
    drawCallout(s, ev("a", 5, 5), callout(side), { isVertical: false, categoryColors: {}, container, onOpenEvent, isMobile: false, ...over });
    return { s, onOpenEvent };
  };
  it("joins the name to the event by a leader, on either side", () => {
    const after = run().s.querySelector("line")!;
    expect([after.getAttribute("x1"), after.getAttribute("x2")]).toEqual(["51", "97"]);
    const before = run({}, "before").s.querySelector("line")!;
    expect([before.getAttribute("x1"), before.getAttribute("x2")]).toEqual(["49", "133"]);
  });
  it("makes the name clickable, with an optional colour override", () => {
    const { s, onOpenEvent } = run({ labelColorOverride: "blue" });
    const t = s.querySelector("text")!;
    expect(t.getAttribute("fill")).toBe("blue");
    t.dispatchEvent(new MouseEvent("click"));
    expect(onOpenEvent).toHaveBeenCalledWith("a");
    expect(run().s.querySelector("text")?.getAttribute("fill")).toBe("var(--text-normal)");
  });
  it("lays out vertically", () => {
    const { s } = run({ isVertical: true });
    expect(s.querySelector("line")?.getAttribute("x1")).toBe(s.querySelector("line")?.getAttribute("x2"));
    expect(s.querySelector("g")?.getAttribute("transform")).toContain("rotate(90)");
  });
});

describe("splitLabelling", () => {
  const e = (id: string, startPx: number, endPx: number, isPoint = false) => ({ ev: ev(id, 0, isPoint ? 0 : 1, { isPoint }), lane: 0, startPx, endPx });
  it("names short bars and visible points, but not bars that hold their own name, nor ones half off screen", () => {
    const { needCallout, occupied } = splitLabelling(
      [e("short", 100, 104), e("wide", 200, 400), e("pt", 300, 300, true), e("edge-pt", 2, 2, true), e("edge-bar", 495, 499), e("off", -10, -6)],
      500,
    );
    expect(needCallout.map((c) => c.id)).toEqual(["short", "pt", "edge-bar"]);
    expect(occupied).toHaveLength(6);
  });
});
