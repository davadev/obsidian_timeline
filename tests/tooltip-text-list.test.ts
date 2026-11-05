// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideTooltip, showTooltip } from "../src/renderer/tooltip";
import { renderList } from "../src/renderer/list-renderer";
import type { RenderOptions } from "../src/renderer/render-options";
import type { TimelineEra, TimelineEvent } from "../src/timeline/model";

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  hideTooltip();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const d = (year: number, month?: number, day?: number) => ({ year, month, day });
const ev = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "e", text: "Event", start: d(2000, 1, 1), end: d(2001, 1, 1), isPoint: false, ...over,
});

describe("tooltip", () => {
  const rect = (width: number, height: number) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width, height } as DOMRect);

  it("shows title, a date range and the optional category and description", () => {
    rect(100, 50);
    showTooltip(document.body, ev({ category: "War", description: "x".repeat(300) }), 10, 20);
    const tip = document.body.querySelector(".txs-tooltip") as HTMLElement;
    expect(tip.querySelector(".txs-tooltip-title")?.textContent).toBe("Event");
    expect(tip.querySelector(".txs-tooltip-dates")?.textContent).toBe("2000-01-01 → 2001-01-01");
    expect(tip.querySelector(".txs-tooltip-category")?.textContent).toBe("Category: War");
    expect(tip.querySelector(".txs-tooltip-desc")?.textContent).toHaveLength(240);
    expect(tip.querySelector(".txs-tooltip-desc")?.textContent?.endsWith("…")).toBe(true);
    expect(tip.style.left).toBe("22px");
    expect(tip.style.top).toBe("32px");
    expect(tip.classList.contains("is-measuring")).toBe(false);
  });

  it("shows one date for a point and omits empty optional rows", () => {
    rect(100, 50);
    showTooltip(document.body, ev({ isPoint: true, description: "short" }), 0, 0);
    expect(document.querySelector(".txs-tooltip-dates")?.textContent).toBe("2000-01-01");
    expect(document.querySelector(".txs-tooltip-category")).toBeNull();
    expect(document.querySelector(".txs-tooltip-desc")?.textContent).toBe("short");
    hideTooltip();
    showTooltip(document.body, ev(), 0, 0);
    expect(document.querySelector(".txs-tooltip-desc")).toBeNull();
  });

  it("flips to the other side of the pointer near the right and bottom edges", () => {
    rect(200, 100);
    vi.stubGlobal("innerWidth", 300);
    vi.stubGlobal("innerHeight", 200);
    showTooltip(document.body, ev(), 250, 150);
    const tip = document.querySelector(".txs-tooltip") as HTMLElement;
    expect(tip.style.left).toBe("38px");
    expect(tip.style.top).toBe("38px");
    vi.unstubAllGlobals();
  });

  it("never flips off the left or top edge", () => {
    rect(500, 500);
    vi.stubGlobal("innerWidth", 300);
    vi.stubGlobal("innerHeight", 300);
    showTooltip(document.body, ev(), 5, 5);
    const tip = document.querySelector(".txs-tooltip") as HTMLElement;
    expect(tip.style.left).toBe("8px");
    expect(tip.style.top).toBe("8px");
    vi.unstubAllGlobals();
  });

  it("replaces the previous tooltip, and hiding twice is harmless", () => {
    rect(10, 10);
    showTooltip(document.body, ev(), 0, 0);
    showTooltip(document.body, ev({ text: "Second" }), 0, 0);
    expect(document.querySelectorAll(".txs-tooltip")).toHaveLength(1);
    hideTooltip();
    hideTooltip();
    expect(document.querySelector(".txs-tooltip")).toBeNull();
  });

  it("copes with the tooltip having been detached by someone else", () => {
    rect(10, 10);
    showTooltip(document.body, ev(), 0, 0);
    document.body.innerHTML = "";
    expect(() => hideTooltip()).not.toThrow();
  });
});

describe("text-metrics", () => {
  const load = async (getContext: () => unknown) => {
    vi.stubGlobal("createEl", () => ({ getContext }));
    return import("../src/renderer/text-metrics");
  };

  it("falls back to a character estimate when there is no canvas context", async () => {
    const m = await load(() => null);
    expect(m.measurerFor("12px x")("abcd")).toBe(4 * m.FALLBACK_CHAR_WIDTH);
  });

  it("falls back when creating the context throws", async () => {
    const m = await load(() => {
      throw new Error("no canvas");
    });
    expect(m.measurerFor("12px x")("ab")).toBe(2 * m.FALLBACK_CHAR_WIDTH);
  });

  it("measures with the canvas and caches per font and string", async () => {
    const measureText = vi.fn((t: string) => ({ width: t.length * 3 }));
    const ctx = { font: "", measureText };
    const m = await load(() => ctx);
    const a = m.measurerFor("12px a");
    expect(a("hello")).toBe(15);
    expect(ctx.font).toBe("12px a");
    expect(a("hello")).toBe(15);
    expect(measureText).toHaveBeenCalledTimes(1);
    expect(m.measurerFor("14px b")("hello")).toBe(15);
    expect(measureText).toHaveBeenCalledTimes(2);
  });

  it("builds a font from the computed family, or sans-serif when there is none", async () => {
    const m = await load(() => null);
    const el = document.createElement("div");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontFamily: "Inter" } as CSSStyleDeclaration);
    expect(m.labelFontSpec(el)).toBe("400 12px Inter");
    expect(m.labelFontSpec(el, 10, 700)).toBe("700 10px Inter");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontFamily: "" } as CSSStyleDeclaration);
    expect(m.labelFontSpec(el)).toBe("400 12px sans-serif");
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
      throw new Error("no layout");
    });
    expect(m.labelFontSpec(el)).toBe("400 12px sans-serif");
  });
});

const opts = (over: Partial<RenderOptions> = {}): RenderOptions =>
  ({
    mode: "list", source: "main", details: "list", sort: "chronological",
    show: ["title", "date", "category", "description", "tags", "links"], zoom: 1, orientation: "horizontal",
    showFilterUI: false, ...over,
  }) as RenderOptions;

describe("renderList", () => {
  const run = (events: TimelineEvent[], over: Partial<RenderOptions> = {}, extra: Record<string, unknown> = {}) => {
    const container = document.body.appendChild(document.createElement("div"));
    const open = vi.fn();
    renderList({ container, events, options: opts(over), onOpenEvent: open, ...extra });
    return { container, open };
  };

  it("lists events with date, category colour, description, tags and links", () => {
    const { container } = run(
      [ev({ category: "War", description: "desc", labels: ["a", "b"], hyperlink: "http://x" })],
      {},
      { categoryColors: { War: "#ffffff" } },
    );
    const li = container.querySelector("li")!;
    expect(li.querySelector(".txs-date")?.textContent).toBe("2000-01-01 → 2001-01-01");
    expect((li.querySelector(".txs-category") as HTMLElement).style.color).toBe("rgb(26, 26, 26)");
    expect(li.querySelector(".txs-desc")?.textContent).toBe("desc");
    expect(li.textContent).toContain("tags: a, b");
    const link = li.querySelector("a.txs-list-link") as HTMLAnchorElement;
    expect(link.getAttribute("rel")).toBe("noopener");
  });

  it("shows a single date for a point, hides unlisted fields and unknown category colours", () => {
    const { container } = run([ev({ isPoint: true, category: "War", description: "d" })], { show: ["title"] });
    expect(container.querySelector(".txs-date")).toBeNull();
    expect(container.querySelector(".txs-category")).toBeNull();
    const shown = run([ev({ isPoint: true, category: "War" })]);
    expect(shown.container.querySelector(".txs-date")?.textContent).toBe("2000-01-01");
    expect((shown.container.querySelector(".txs-category") as HTMLElement).style.background).toBe("");
  });

  it("truncates descriptions only in compact mode", () => {
    const long = "y".repeat(200);
    expect(run([ev({ description: long })], { details: "compact" }).container.querySelector(".txs-desc")?.textContent).toHaveLength(160);
    expect(run([ev({ description: "short" })], { details: "compact" }).container.querySelector(".txs-desc")?.textContent).toBe("short");
    expect(run([ev({ description: long })]).container.querySelector(".txs-desc")?.textContent).toHaveLength(200);
  });

  it("sorts chronologically, in reverse, or by category then date", () => {
    const events = [
      ev({ id: "b", text: "B", start: d(2), category: "Z" }),
      ev({ id: "a", text: "A", start: d(1), category: "Z" }),
      ev({ id: "c", text: "C", start: d(3) }),
      ev({ id: "d", text: "D", start: d(0), category: "Y" }),
    ];
    const titles = (sort: RenderOptions["sort"]) =>
      [...run(events, { sort }).container.querySelectorAll("li > .txs-title")].map((e) => e.textContent);
    expect(titles("chronological")).toEqual(["D", "A", "B", "C"]);
    expect(titles("reverse-chronological")).toEqual(["C", "B", "A", "D"]);
    expect(titles("category")).toEqual(["C", "D", "A", "B"]);
  });

  it("opens the note from the title link and the explicit action", () => {
    const { container, open } = run([ev({ id: "x" })]);
    (container.querySelector("a.txs-title") as HTMLElement).click();
    (container.querySelector("a.txs-open-note") as HTMLElement).click();
    expect(open.mock.calls).toEqual([["x"], ["x"]]);
  });

  it("uses plain-text titles on mobile, leaving only the explicit action to navigate", () => {
    const { container, open } = run([ev({ id: "m" })], {}, { isMobile: true });
    expect(container.querySelector("a.txs-title")).toBeNull();
    expect(container.querySelector("span.txs-title")?.textContent).toBe("Event");
    (container.querySelector("a.txs-open-note") as HTMLElement).click();
    expect(open).toHaveBeenCalledWith("m");
  });

  it("lists eras first, ordered by start, with swatches and an optional open link", () => {
    const era = (id: string, y: number, m: number | undefined, color?: string): TimelineEra => ({
      id, name: id, start: d(y, m), end: d(y + 1), color,
    });
    const onOpenEra = vi.fn();
    const { container } = run([], {}, {
      eras: [era("late", 5, undefined, "1,2,3"), era("same-b", 1, 6, "#abc"), era("same-a", 1, 2), era("early", 0, 1), era("late2", 5, undefined)],
      onOpenEra,
    });
    const names = [...container.querySelectorAll(".txs-era-list-item .txs-list-era-title")].map((e) => e.textContent?.trim());
    expect(names).toEqual(["early", "same-a", "same-b", "late", "late2"]);
    const sw = [...container.querySelectorAll<HTMLElement>(".txs-era-chip-sw")].map((e) => e.style.background);
    expect(sw[0]).toBe("var(--text-muted)");
    expect(sw[2]).toBe("rgb(170, 187, 204)");
    expect(sw[3]).toBe("rgb(1, 2, 3)");
    (container.querySelectorAll(".txs-era-list-item a")[0] as HTMLElement).click();
    expect(onOpenEra).toHaveBeenCalledWith("early");
  });

  it("omits the era open link without a handler, and the era section without eras", () => {
    const withEras = run([], {}, { eras: [{ id: "e", name: "E", start: d(1), end: d(2) }] });
    expect(withEras.container.querySelector(".txs-era-list-item a")).toBeNull();
    expect(run([], {}, { eras: [] }).container.querySelector(".txs-era-list")).toBeNull();
  });

  it("picks readable text on dark, rgb() and unparseable category fills", () => {
    const color = (fill: string) => {
      const { container } = run([ev({ category: "C" })], {}, { categoryColors: { C: fill } });
      return (container.querySelector(".txs-category") as HTMLElement).style.color;
    };
    expect(color("#000000")).toBe("rgb(255, 255, 255)");
    expect(color("rgb(255, 255, 255)")).toBe("rgb(26, 26, 26)");
    expect(color("var(--accent)")).toBe("rgb(26, 26, 26)"); // unparseable: assumed light grey
  });
});
