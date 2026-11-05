// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Platform, WorkspaceLeaf } from "../testUtils/obsidian";
import { TimelineView, VIEW_TYPE_TIMELINE } from "../src/obsidian/timeline-view";
import { DEFAULT_SETTINGS, type TimelineXmlSyncSettings } from "../src/settings";
import { initDeviceStore } from "../src/obsidian/app-storage";
import { FakeApp } from "../testUtils/fake-app";
import type { TimelineDoc, TimelineEvent } from "../src/timeline/model";

const d = (year: number) => ({ year });
const ev = (id: string, a: number, b: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, text: `Event ${id}`, start: d(a), end: d(b), isPoint: a === b, ...over,
});
const DOC: TimelineDoc = {
  categories: [{ name: "War" }, { name: "Peace" }],
  events: [ev("a", 100, 200, { category: "War", labels: ["x"] }), ev("b", 300, 400, { category: "Peace", labels: ["y"], description: "treaty" }), ev("c", 500, 500)],
  eras: [{ id: "e", name: "Era", start: d(0), end: d(450) }],
};

let settings: TimelineXmlSyncSettings;
let doc: TimelineDoc | Error;
let cache: { getRenderDoc: ReturnType<typeof vi.fn>; invalidateXml: ReturnType<typeof vi.fn>; invalidateMdDoc: ReturnType<typeof vi.fn> };
let onEventClick: Mock<(id: string) => void>;
let onEraClick: Mock<(id: string) => void>;

const open = async () => {
  const view = new TimelineView(new WorkspaceLeaf() as never, {
    app: {} as never, cache: cache as never, getSettings: () => settings, onEventClick: onEventClick as never, onEraClick: onEraClick as never,
  });
  await view.onOpen();
  return view;
};
const type = (el: Element, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input"));
};
const listText = (v: TimelineView) => [...v.contentEl.querySelectorAll(".txs-view-list .txs-timeline-list li > .txs-title")].map((e) => e.textContent);
const labelOf = (v: TimelineView) => v.contentEl.querySelector(".txs-view-zoom-label")?.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  initDeviceStore(new FakeApp() as never); // fresh device storage per test
  settings = { ...DEFAULT_SETTINGS, renderDefaults: { ...DEFAULT_SETTINGS.renderDefaults, mode: "hybrid" } };
  doc = DOC;
  cache = {
    getRenderDoc: vi.fn(async () => {
      if (doc instanceof Error) throw doc;
      return doc;
    }),
    invalidateXml: vi.fn(),
    invalidateMdDoc: vi.fn(),
  };
  onEventClick = vi.fn<(id: string) => void>();
  onEraClick = vi.fn<(id: string) => void>();
  Platform.isMobile = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("identity and lifecycle", () => {
  it("is the Timeline view", async () => {
    const v = await open();
    expect(v.getViewType()).toBe(VIEW_TYPE_TIMELINE);
    expect(v.getDisplayText()).toBe("Timeline");
    expect(v.getIcon()).toBe("calendar-range");
    await v.onClose();
    expect(v.contentEl.children).toHaveLength(0);
  });

  it("shows an error when the timeline cannot be loaded", async () => {
    doc = new Error("no data");
    const v = await open();
    expect(v.contentEl.textContent).toContain("Timeline view error: no data");
    expect(v.contentEl.querySelector(".txs-view-filters")).toBeNull();
  });
});

describe("rendering", () => {
  it("draws the chart and a compact list of every event, plus eras", async () => {
    const v = await open();
    expect(v.contentEl.querySelector(".txs-view-chart .txs-chart")).not.toBeNull();
    expect(listText(v)).toEqual(["Event a", "Event b", "Event c"]);
    expect(v.contentEl.querySelector(".txs-era-list")).not.toBeNull();
    expect(labelOf(v)).toMatch(/×$/); // the chart reported its zoom
  });

  it("routes clicks on list entries and eras", async () => {
    const v = await open();
    (v.contentEl.querySelector(".txs-view-list a.txs-title") as HTMLElement).click();
    (v.contentEl.querySelector(".txs-view-list .txs-era-list-item a") as HTMLElement).click();
    expect(onEventClick).toHaveBeenCalledWith("a");
    expect(onEraClick).toHaveBeenCalledWith("e");
  });

  it("routes clicks on bars and eras in the chart", async () => {
    const v = await open();
    (v.contentEl.querySelector(".txs-chart .txs-event-bar") as unknown as SVGElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onEventClick).toHaveBeenCalled();
    (v.contentEl.querySelector(".txs-chart rect[opacity='0.18']") as unknown as SVGElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onEraClick).toHaveBeenCalledWith("e");
  });

  it("list mode draws no chart, and bar mode no list", async () => {
    settings.renderDefaults.mode = "list";
    const l = await open();
    expect(l.contentEl.querySelector(".txs-chart")).toBeNull();
    expect(listText(l)).toHaveLength(3);
    document.body.innerHTML = "";
    settings.renderDefaults.mode = "bar";
    const b = await open();
    expect(b.contentEl.querySelector(".txs-chart")).not.toBeNull();
    expect(listText(b)).toHaveLength(0);
  });

  it("starts the filter panel collapsed on mobile and lets it toggle", async () => {
    Platform.isMobile = true;
    const v = await open();
    const panel = v.contentEl.querySelector(".txs-view-filters") as HTMLElement;
    expect(panel.classList.contains("is-open")).toBe(false);
    const summary = panel.querySelector("button") as HTMLElement;
    summary.click();
    expect(panel.classList.contains("is-open")).toBe(true);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    summary.click();
    expect(panel.classList.contains("is-open")).toBe(false);
  });

  it("tolerates a document with no eras and no categories", async () => {
    doc = { categories: [], events: [ev("a", 1, 2)] };
    const v = await open();
    expect(v.contentEl.querySelector(".txs-filter-chip")).toBeNull();
    expect(listText(v)).toEqual(["Event a"]);
  });

  it("builds an orientation-aware, mobile-aware chart from settings", async () => {
    settings.renderDefaults.orientation = "vertical";
    Platform.isMobile = true;
    const v = await open();
    expect(v.contentEl.querySelector(".txs-chart")?.classList.contains("txs-vertical")).toBe(true);
  });
});

describe("filtering", () => {
  it("searches (debounced), filters by labels, and shows a badge", async () => {
    const v = await open();
    const search = v.contentEl.querySelector(".txs-view-search") as HTMLInputElement;
    type(search, "treaty");
    expect(listText(v)).toHaveLength(3);
    expect(v.contentEl.querySelector(".txs-view-filters-badge")?.textContent).toBe("Filters (1 active)");
    vi.advanceTimersByTime(250);
    expect(listText(v)).toEqual(["Event b"]);
    type(search, "t");
    type(search, "tr");
    vi.advanceTimersByTime(250);
    type(v.contentEl.querySelector(".txs-view-labels")!, "x");
    vi.advanceTimersByTime(250);
    expect(listText(v)).toEqual([]);
    expect(v.contentEl.textContent).toContain("No events match current filters.");
    expect(v.contentEl.querySelector(".txs-view-badge")).toBeNull();
  });

  it("filters by date range at year precision", async () => {
    const v = await open();
    const [from, to] = [...v.contentEl.querySelectorAll<HTMLInputElement>(".txs-view-date-fields input")];
    type(from, "250");
    expect(listText(v)).toEqual(["Event b", "Event c"]);
    type(to, "450");
    expect(listText(v)).toEqual(["Event b"]);
    type(from, "");
    expect(listText(v)).toEqual(["Event a", "Event b"]);
  });

  it("offers month/day and clock inputs at finer precisions", async () => {
    settings.globalFilterPrecision = "day";
    const day = await open();
    expect(day.contentEl.querySelectorAll(".txs-view-date-fields")[0].querySelectorAll("input")).toHaveLength(3);
    document.body.innerHTML = "";
    settings.globalFilterPrecision = "time";
    const time = await open();
    const inputs = [...time.contentEl.querySelectorAll(".txs-view-date-fields")[0].querySelectorAll("input")];
    expect(inputs.map((i) => i.placeholder)).toEqual(["year", "mo", "dd", "hh", "mm", "ss"]);
    inputs.forEach((i, n) => type(i, n === 2 ? " " : String([300, 1, 0, 2, 3, 4][n])));
    expect(listText(time).length).toBeGreaterThan(0);
  });

  it("toggles categories through the chip bar, seeded from the global hidden list", async () => {
    settings.hiddenCategories = ["War"];
    const v = await open();
    expect(listText(v)).toEqual(["Event b", "Event c"]);
    // Chips are listed alphabetically: Peace, War.
    const chips = [...v.contentEl.querySelectorAll<HTMLElement>(".txs-filter-chip")];
    expect(chips.map((c) => c.classList.contains("is-active"))).toEqual([true, false]);
    chips[1].click(); // show War again
    expect(v.contentEl.querySelector(".txs-view-filters-badge")?.textContent).toBe("Filters");
    expect(listText(v)).toHaveLength(3);
    chips[0].click(); // hide Peace
    expect(v.contentEl.querySelector(".txs-view-filters-badge")?.textContent).toBe("Filters (1 active)");
    expect(listText(v)).toEqual(["Event a", "Event c"]);
  });

  it("Clear filters resets every input and the zoom", async () => {
    const v = await open();
    type(v.contentEl.querySelector(".txs-view-search")!, "treaty");
    type(v.contentEl.querySelector(".txs-view-labels")!, "y");
    const from = v.contentEl.querySelector<HTMLInputElement>(".txs-view-date-fields input")!;
    type(from, "250");
    [...v.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click();
    expect((v.contentEl.querySelector(".txs-view-search") as HTMLInputElement).value).toBe("");
    expect(from.value).toBe("");
    expect(listText(v)).toHaveLength(3);
    expect(labelOf(v)).toMatch(/×$|Auto/);
  });

  it("keeps filters across a refresh from the cache", async () => {
    const v = await open();
    type(v.contentEl.querySelector(".txs-view-search")!, "treaty");
    vi.advanceTimersByTime(250);
    doc = { ...DOC, events: [...DOC.events, ev("d", 700, 800, { description: "treaty two" })] };
    await v.refreshFromCache();
    expect(listText(v)).toEqual(["Event b", "Event d"]);
  });
});

describe("rebuilding the panel keeps what was entered", () => {
  const refresh = async (v: TimelineView, calls: number) => {
    [...v.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click();
    await vi.waitFor(() => expect(cache.getRenderDoc).toHaveBeenCalledTimes(calls));
    await vi.waitFor(() => expect(v.contentEl.querySelector(".txs-view-body")).not.toBeNull());
  };

  it("re-fills the date inputs and the hidden categories after a reload", async () => {
    settings.globalFilterPrecision = "time";
    const v = await open();
    const first = [...v.contentEl.querySelectorAll(".txs-view-date-fields")[0].querySelectorAll<HTMLInputElement>("input")];
    first.forEach((i, n) => type(i, String([300, 1, 2, 3, 4, 5][n])));
    v.contentEl.querySelector<HTMLElement>(".txs-filter-chip")!.click(); // hide Peace
    await refresh(v, 2);
    const again = [...v.contentEl.querySelectorAll(".txs-view-date-fields")[0].querySelectorAll<HTMLInputElement>("input")];
    expect(again.map((i) => i.value)).toEqual(["300", "1", "2", "3", "4", "5"]);
    const chips = [...v.contentEl.querySelectorAll<HTMLElement>(".txs-filter-chip")];
    expect(chips.map((c) => c.classList.contains("is-active"))).toEqual([false, true]);
  });

  it("fits the chart to events in any order", async () => {
    doc = { categories: [], events: [ev("late", 700, 800), ev("early", 100, 200)] };
    const v = await open();
    expect(listText(v)).toEqual(["Event early", "Event late"]);
  });
});

describe("refresh", () => {
  it("the Refresh button invalidates the caches and reloads", async () => {
    const v = await open();
    [...v.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click();
    expect(cache.invalidateXml).toHaveBeenCalled();
    expect(cache.invalidateMdDoc).toHaveBeenCalled();
    await vi.waitFor(() => expect(cache.getRenderDoc).toHaveBeenCalledTimes(2));
  });

  it("refreshFromCache keeps the old view when the reload fails, and is harmless before opening", async () => {
    const v = await open();
    doc = new Error("transient");
    await v.refreshFromCache();
    expect(listText(v)).toHaveLength(3);
    const unopened = new TimelineView(new WorkspaceLeaf() as never, {
      app: {} as never, cache: cache as never, getSettings: () => settings, onEventClick: vi.fn(), onEraClick: vi.fn(),
    });
    doc = DOC;
    await unopened.refreshFromCache();
  });

  it("survives a render that lands while the document is being reloaded", async () => {
    const v = await open();
    const search = v.contentEl.querySelector(".txs-view-search")!;
    [...v.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!.click();
    type(search, "x"); // the old panel's debounce fires while the cache is null
    vi.advanceTimersByTime(250);
    await vi.waitFor(() => expect(cache.getRenderDoc).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(v.contentEl.querySelector(".txs-view-body")).not.toBeNull());
  });

  it("switches from chart to list live when the mode setting changes", async () => {
    const v = await open();
    settings.renderDefaults.mode = "list";
    await v.refreshFromCache();
    expect(v.contentEl.querySelector(".txs-chart")).toBeNull();
    settings.renderDefaults.mode = "hybrid";
    await v.refreshFromCache();
    expect(v.contentEl.querySelector(".txs-chart")).not.toBeNull();
  });
});

describe("zoom controls", () => {
  it("zoom in/out go through the chart and the label resets to automatic", async () => {
    const v = await open();
    const [out, label, inn] = [...v.contentEl.querySelectorAll<HTMLButtonElement>(".txs-view-zoom button")];
    const before = labelOf(v);
    inn.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(labelOf(v)).not.toBe(before);
    out.click();
    label.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(inn.disabled).toBe(false);
  });

  it("disables zoom-in at the ceiling", async () => {
    const v = await open();
    const inn = v.contentEl.querySelectorAll<HTMLButtonElement>(".txs-view-zoom button")[2];
    for (let i = 0; i < 60; i++) inn.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(inn.disabled).toBe(true);
    expect(v.contentEl.querySelector(".txs-view-zoom-label")?.getAttribute("aria-label")).toContain("Maximum zoom");
  });

  it("with no chart, reset re-renders only if a zoom was set, and zoom buttons do nothing", async () => {
    const v = await open();
    const priv = v as unknown as { chart: { destroy(): void } | null; filters: { zoom: number | null } };
    const label = v.contentEl.querySelector<HTMLButtonElement>(".txs-view-zoom-label")!;
    const inn = v.contentEl.querySelectorAll<HTMLButtonElement>(".txs-view-zoom button")[2];
    priv.chart?.destroy();
    priv.chart = null;
    priv.filters.zoom = null;
    label.click();
    inn.click();
    priv.filters.zoom = 4;
    label.click();
    expect(priv.filters.zoom).toBeNull();
    expect(labelOf(v)).toBe("Auto");
    priv.filters.zoom = 4;
    label.click();
    label.click(); // a render is already pending: coalesced
    await vi.advanceTimersByTimeAsync(50);
    expect(v.contentEl.querySelector(".txs-chart")).not.toBeNull(); // re-rendered once, chart back
  });

  it("keeps the label in step with the chart's zoom, on a view that has no label element yet", async () => {
    const v = await open();
    (v as unknown as { zoomLabelEl: null }).zoomLabelEl = null;
    v.contentEl.querySelectorAll<HTMLButtonElement>(".txs-view-zoom button")[0].click();
    (v as unknown as { updateZoomLabel(): void }).updateZoomLabel();
  });
});
