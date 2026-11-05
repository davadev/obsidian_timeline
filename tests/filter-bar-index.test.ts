// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRichFilter,
  distinctCategories,
  loadHidden,
  renderFilterBar,
  renderRichFilterBar,
  type RichFilterState,
} from "../src/renderer/filter-bar";
import { renderTimeline } from "../src/renderer";
import { DEFAULT_RENDER_OPTIONS } from "../src/renderer/render-options";
import { clearDevice, initDeviceStore, readDevice, writeDevice } from "../src/obsidian/app-storage";
import { effectiveAutoSync, getDeviceSyncMode, setDeviceSyncMode } from "../src/obsidian/device-prefs";
import type { TimelineEvent } from "../src/timeline/model";

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ev = (id: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, text: id, start: { year: 2000 }, end: { year: 2001 }, isPoint: false, ...over,
});
const parent = () => document.body.appendChild(document.createElement("div"));
const type = (el: Element, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input"));
};

describe("app-storage without an App", () => {
  it("keeps values in memory and can clear them", () => {
    expect(readDevice("k")).toBeNull();
    writeDevice("k", { a: 1 });
    expect(readDevice("k")).toEqual({ a: 1 });
    clearDevice("k");
    expect(readDevice("k")).toBeNull();
  });
});

describe("app-storage with an App", () => {
  const store = new Map<string, unknown>();
  const app = {
    loadLocalStorage: vi.fn((k: string) => store.get(k) ?? null),
    saveLocalStorage: vi.fn((k: string, v: unknown) => (v === null ? store.delete(k) : store.set(k, v))),
  };
  beforeEach(() => {
    store.clear();
    initDeviceStore(app as never);
  });
  afterEach(() => initDeviceStore(null as never));

  it("reads and writes through the App", () => {
    writeDevice("k", 5);
    expect(readDevice("k")).toBe(5);
    expect(app.saveLocalStorage).toHaveBeenCalledWith("k", 5);
  });

  it("migrates a JSON legacy localStorage value once and removes it", () => {
    window.localStorage.setItem("old", JSON.stringify(["a"]));
    expect(readDevice("new", "old")).toEqual(["a"]);
    expect(window.localStorage.getItem("old")).toBeNull();
    expect(store.get("new")).toEqual(["a"]);
  });

  it("migrates a plain-string legacy value", () => {
    window.localStorage.setItem("old", "plain");
    expect(readDevice("new", "old")).toBe("plain");
  });

  it("returns null when there is no legacy value or it cannot be read", () => {
    expect(readDevice("new", "missing")).toBeNull();
    expect(readDevice("new")).toBeNull();
    const spy = vi.spyOn(Object.getPrototypeOf(window.localStorage), "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readDevice("new", "old")).toBeNull();
    spy.mockRestore();
  });

  it("clears the value and the legacy key, ignoring unavailable storage", () => {
    window.localStorage.setItem("old", "x");
    clearDevice("k", "old");
    expect(app.saveLocalStorage).toHaveBeenCalledWith("k", null);
    expect(window.localStorage.getItem("old")).toBeNull();
    clearDevice("k");
    const spy = vi.spyOn(Object.getPrototypeOf(window.localStorage), "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => clearDevice("k", "old")).not.toThrow();
    spy.mockRestore();
  });

  it("device prefs: global is the default and clears; on/off override the global setting", () => {
    expect(getDeviceSyncMode()).toBe("global");
    expect(effectiveAutoSync(true)).toBe(true);
    expect(effectiveAutoSync(false)).toBe(false);
    setDeviceSyncMode("on");
    expect(getDeviceSyncMode()).toBe("on");
    expect(effectiveAutoSync(false)).toBe(true);
    setDeviceSyncMode("off");
    expect(effectiveAutoSync(true)).toBe(false);
    setDeviceSyncMode("global");
    expect(getDeviceSyncMode()).toBe("global");
    writeDevice("device-sync", "garbage");
    expect(getDeviceSyncMode()).toBe("global");
  });
});

describe("renderFilterBar (category chips)", () => {
  const make = (over = {}) => {
    const onChange = vi.fn();
    const bar = renderFilterBar({
      parent: parent(), sourceKey: "s", allCategories: ["A", "B"], initialHidden: ["A"],
      categoryColors: { A: "red" }, onChange, ...over,
    });
    return { bar, onChange };
  };
  const chips = (bar: HTMLElement) => [...bar.querySelectorAll<HTMLElement>(".txs-filter-chip")];

  it("paints chips from the initial hidden set and falls back to a muted swatch", () => {
    const { bar } = make();
    expect(chips(bar).map((c) => c.classList.contains("is-active"))).toEqual([false, true]);
    const sw = [...bar.querySelectorAll<HTMLElement>(".txs-filter-swatch")].map((s) => s.style.background);
    expect(sw).toEqual(["red", "var(--text-muted)"]);
  });

  it("toggles a chip, persists it and reports the hidden set", () => {
    const { bar, onChange } = make();
    chips(bar)[0].click();
    expect(onChange).toHaveBeenLastCalledWith(new Set());
    chips(bar)[1].click();
    expect(onChange).toHaveBeenLastCalledWith(new Set(["B"]));
    expect(loadHidden("s")).toEqual(["B"]);
  });

  it("All shows everything and None hides everything", () => {
    const { bar, onChange } = make();
    const [all, none] = [...bar.querySelectorAll<HTMLElement>(".txs-filter-action")];
    none.click();
    expect(onChange).toHaveBeenLastCalledWith(new Set(["A", "B"]));
    expect(chips(bar).every((c) => c.classList.contains("is-inactive"))).toBe(true);
    all.click();
    expect(onChange).toHaveBeenLastCalledWith(new Set());
    expect(chips(bar).every((c) => c.classList.contains("is-active"))).toBe(true);
  });

  it("merges persisted hidden categories and ignores a malformed stored value", () => {
    writeDevice("filter:hidden:s", ["B", 3]);
    const { bar } = make();
    expect(chips(bar).map((c) => c.classList.contains("is-active"))).toEqual([false, false]);
    writeDevice("filter:hidden:s", "nope");
    expect(loadHidden("s")).toEqual([]);
  });
});

describe("distinctCategories", () => {
  it("merges event and catalog categories, sorted, skipping blanks", () => {
    expect(distinctCategories([ev("a", { category: "Z" }), ev("b"), ev("c", { category: "Z" })], [{ name: "M" }, { name: "" }])).toEqual(["M", "Z"]);
  });
});

describe("applyRichFilter", () => {
  const base: RichFilterState = { hiddenCategories: new Set(), search: "", labels: [], start: null, end: null, zoom: null };
  const events = [
    ev("a", { text: "Rome falls", category: "War", labels: ["Empire"], start: { year: 400 }, end: { year: 476 } }),
    ev("b", { text: "Plain", description: "mentions ROME", start: { year: -2000, month: 6, day: 15 }, end: { year: -2000, month: 6, day: 15 } }),
    ev("c", { text: "Other", category: "Peace", start: { year: 1000 }, end: { year: 1001 } }),
  ];
  const ids = (s: Partial<RichFilterState>) => applyRichFilter(events, { ...base, ...s }).map((e) => e.id);

  it("passes everything with an empty filter", () => expect(ids({})).toEqual(["a", "b", "c"]));
  it("hides categories, but not uncategorised events", () => expect(ids({ hiddenCategories: new Set(["War"]) })).toEqual(["b", "c"]));
  it("searches title, description and category case-insensitively", () => {
    expect(ids({ search: " rome " })).toEqual(["a", "b"]);
    expect(ids({ search: "peace" })).toEqual(["c"]);
  });
  it("matches labels case-insensitively", () => {
    expect(ids({ labels: ["empire"] })).toEqual(["a"]);
    expect(ids({ labels: ["nothing"] })).toEqual([]);
  });
  it("treats a partial end date as inclusive to the end of its period", () => {
    expect(ids({ end: { year: -2000 } })).toEqual(["b"]);
    expect(ids({ end: { year: -2000, month: 6 } })).toEqual(["b"]);
    expect(ids({ end: { year: -2000, month: 6, day: 15 } })).toEqual(["b"]);
    expect(ids({ end: { year: -2000, month: 6, day: 14 } })).toEqual([]);
    expect(ids({ end: { year: -2000, month: 6, day: 15, hour: 0 } })).toEqual(["b"]);
    expect(ids({ end: { year: -2000, month: 6, day: 15, hour: 0, minute: 0 } })).toEqual(["b"]);
    expect(ids({ end: { year: -2000, month: 6, day: 15, hour: 0, minute: 0, second: 0 } })).toEqual(["b"]);
    expect(ids({ end: { year: 2024, month: 2 } })).toEqual(["a", "b", "c"]);
    expect(ids({ end: { year: 900, month: 2 } })).toEqual(["a", "b"]);
  });
  it("applies a start bound against the event's end", () => {
    expect(ids({ start: { year: 476 } })).toEqual(["a", "c"]);
    expect(ids({ start: { year: 477 } })).toEqual(["c"]);
  });
  it("knows month lengths when expanding an end date", () => {
    const e = ev("x", { start: { year: 2024, month: 2, day: 29 }, end: { year: 2024, month: 2, day: 29 } });
    const f = (end: RichFilterState["end"]) => applyRichFilter([e], { ...base, end }).length;
    expect(f({ year: 2024, month: 2 })).toBe(1);
    expect(f({ year: 2023, month: 2 })).toBe(0);
    const m = (month: number, day: number) => applyRichFilter([ev("y", { start: { year: 2001, month, day }, end: { year: 2001, month, day } })], { ...base, end: { year: 2001, month } }).length;
    expect(m(4, 30)).toBe(1);
    expect(m(1, 31)).toBe(1);
    expect(m(2, 28)).toBe(1);
    expect(applyRichFilter([ev("z", { start: { year: 1900, month: 2, day: 28 }, end: { year: 1900, month: 2, day: 28 } })], { ...base, end: { year: 1900, month: 2 } })).toHaveLength(1);
    expect(applyRichFilter([ev("w", { start: { year: 2000, month: 2, day: 29 }, end: { year: 2000, month: 2, day: 29 } })], { ...base, end: { year: 2000, month: 2 } })).toHaveLength(1);
  });
});

describe("rich filter panel", () => {
  const make = (over: Record<string, unknown> = {}) => {
    const onChange = vi.fn();
    const handle = renderRichFilterBar({
      parent: parent(), sourceKey: "rich", allCategories: ["A", "B"], categoryColors: { A: "red" },
      initialHidden: [], precision: "year", defaultOpen: true, onChange, ...over,
    } as never);
    const panel = document.body.querySelector("details") as HTMLDetailsElement;
    return { handle, onChange, panel };
  };
  const inputs = (panel: HTMLElement, type_?: string) => [...panel.querySelectorAll<HTMLInputElement>(type_ ? `input[type=${type_}]` : "input")];

  it("starts collapsed or open and shows an active-filter count", () => {
    expect(make({ defaultOpen: false }).panel.open).toBe(false);
    document.body.innerHTML = "";
    const { panel, handle } = make({ initialHidden: ["A"] });
    expect(panel.open).toBe(true);
    expect(panel.querySelector("summary span")?.textContent).toBe("Filters (1 active)");
    expect(handle.state.hiddenCategories.has("A")).toBe(true);
  });

  it("debounces typing, persists the state and calls onChange once", () => {
    const { panel, onChange, handle } = make();
    const search = inputs(panel, "search")[0];
    type(search, "r");
    type(search, "ro");
    vi.advanceTimersByTime(249);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(handle.state.search).toBe("ro");
    expect(panel.querySelector("summary span")?.textContent).toBe("Filters (1 active)");
    expect(readDevice<{ search: string }>("richfilter:rich")?.search).toBe("ro");
  });

  it("splits labels on space, comma and semicolon", () => {
    const { panel, handle } = make();
    type(inputs(panel, "text")[0], "a, b;c  d");
    expect(handle.state.labels).toEqual(["a", "b", "c", "d"]);
  });

  it("reads the zoom override, ignoring blank, zero, negative and junk values", () => {
    const { panel, handle } = make();
    const zoom = panel.querySelector<HTMLInputElement>(".txs-filter-zoom-input")!;
    type(zoom, "3");
    expect(handle.state.zoom).toBe(3);
    type(zoom, "0");
    expect(handle.state.zoom).toBeNull();
    type(zoom, "-2");
    expect(handle.state.zoom).toBeNull();
    type(zoom, "abc");
    expect(handle.state.zoom).toBeNull();
    type(zoom, "2");
    type(zoom, "");
    expect(handle.state.zoom).toBeNull();
  });

  it("reads year-only date inputs, and clears the date when the year is blank or junk", () => {
    const { panel, handle } = make();
    const [from, to] = inputs(panel, "number").filter((i) => i.placeholder === "year");
    type(from, "-500");
    expect(handle.state.start).toEqual({ year: -500, month: undefined, day: undefined, hour: undefined, minute: undefined, second: undefined });
    type(to, "100");
    expect(handle.state.end?.year).toBe(100);
    type(from, "");
    expect(handle.state.start).toBeNull();
    type(from, "e"); // a number input refuses text, leaving it blank
    expect(handle.state.start).toBeNull();
  });

  it("offers month and day inputs at day precision, and the clock at time precision", () => {
    const day = make({ precision: "day" });
    const placeholders = (p: HTMLElement) => inputs(p, "number").map((i) => i.placeholder);
    expect(placeholders(day.panel).slice(0, 3)).toEqual(["year", "mo", "dd"]);
    document.body.innerHTML = "";
    const time = make({ precision: "time" });
    expect(placeholders(time.panel).slice(0, 6)).toEqual(["year", "mo", "dd", "hh", "mm", "ss"]);
    const [y, mo, dd, hh, mi, ss] = inputs(time.panel, "number");
    type(y, "2000"); type(mo, "5"); type(dd, "x"); type(hh, "6"); type(mi, " "); type(ss, "7");
    expect(time.handle.state.start).toEqual({ year: 2000, month: 5, day: undefined, hour: 6, minute: undefined, second: 7 });
  });

  it("restores persisted state, including prefilled date inputs and the zoom", () => {
    writeDevice("richfilter:rich", {
      hiddenCategories: ["B"], search: "q", labels: ["l"], start: { year: 1, month: 2, hour: 5, minute: 6, second: 7 }, end: { year: 3 }, zoom: 4,
    });
    const { panel, handle } = make({ precision: "time" });
    expect(handle.state).toMatchObject({ search: "q", labels: ["l"], zoom: 4 });
    expect(handle.state.hiddenCategories.has("B")).toBe(true);
    expect(inputs(panel, "search")[0].value).toBe("q");
    expect(inputs(panel, "text")[0].value).toBe("l");
    expect(panel.querySelector<HTMLInputElement>(".txs-filter-zoom-input")!.value).toBe("4");
    expect(inputs(panel, "number").filter((i) => i.value).map((i) => i.value)).toEqual(["1", "2", "5", "6", "7", "3", "4"]);
  });

  it("sanitises a malformed persisted value", () => {
    writeDevice("richfilter:rich", { hiddenCategories: "x", search: 3, labels: "y", zoom: -1 });
    const { handle } = make();
    expect(handle.state).toMatchObject({ search: "", labels: [], start: null, end: null, zoom: null });
    expect(handle.state.hiddenCategories.size).toBe(0);
    writeDevice("richfilter:rich", "junk");
    document.body.innerHTML = "";
    expect(make().handle.state.search).toBe("");
  });

  it("toggles category chips, and omits the category row when there are none", () => {
    const { panel, handle } = make();
    const chip = panel.querySelector<HTMLElement>(".txs-filter-chip")!;
    chip.click();
    expect(handle.state.hiddenCategories.has("A")).toBe(true);
    expect(chip.classList.contains("is-inactive")).toBe(true);
    chip.click();
    expect(handle.state.hiddenCategories.has("A")).toBe(false);
    const sw = [...panel.querySelectorAll<HTMLElement>(".txs-filter-swatch")].map((s) => s.style.background);
    expect(sw).toEqual(["red", "var(--text-muted)"]);
    document.body.innerHTML = "";
    expect(make({ allCategories: [] }).panel.querySelector(".txs-filter-chip")).toBeNull();
  });

  it("Clear filters resets every control and notifies", () => {
    const { panel, handle, onChange } = make({ initialHidden: ["A"], precision: "day" });
    type(inputs(panel, "search")[0], "x");
    type(inputs(panel, "number")[0], "5");
    panel.querySelector<HTMLElement>(".txs-filter-chip")!.click();
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!.click();
    expect(handle.state).toMatchObject({ search: "", labels: [], start: null, end: null, zoom: null });
    expect(handle.state.hiddenCategories.size).toBe(0);
    expect(inputs(panel).every((i) => i.value === "")).toBe(true);
    expect([...panel.querySelectorAll(".txs-filter-chip")].every((c) => c.classList.contains("is-active"))).toBe(true);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalled();
  });
});

describe("renderTimeline", () => {
  const args = (over: Record<string, unknown> = {}) => ({
    container: parent(),
    events: [ev("a", { category: "A" }), ev("b", { category: "B", start: { year: 1500 }, end: { year: 1501 } })],
    categories: [], viewport: undefined, options: { ...DEFAULT_RENDER_OPTIONS, mode: "hybrid", showFilterUI: false },
    onOpenEvent: vi.fn(), categoryColors: {}, initialHidden: [], filterKey: "idx", isMobile: false, ...over,
  });

  it("renders the chart and the list for a hybrid block, and only the list in list mode", () => {
    const a = args();
    renderTimeline(a as never);
    expect(a.container.querySelector(".txs-timeline-chart")?.children.length).toBeGreaterThan(0);
    expect(a.container.querySelector(".txs-timeline-list")).not.toBeNull();
    const l = args({ options: { ...DEFAULT_RENDER_OPTIONS, mode: "list", showFilterUI: false } });
    renderTimeline(l as never);
    expect(l.container.querySelector(".txs-timeline-chart")?.children.length).toBe(0);
  });

  it("renders only the chart in bar mode", () => {
    const a = args({ options: { ...DEFAULT_RENDER_OPTIONS, mode: "bar", showFilterUI: false } });
    renderTimeline(a as never);
    expect(a.container.querySelector(".txs-timeline-list")).toBeNull();
  });

  it("skips the chart when there is no viewport and no events, and says so", () => {
    const a = args({ events: [] });
    renderTimeline(a as never);
    expect(a.container.textContent).toContain("No events to display.");
    expect(a.container.querySelector(".txs-filter-empty-hint")).toBeNull();
  });

  it("explains when the filters hide every event, and applies a date range and zoom override", () => {
    const onFilterChange = vi.fn();
    const a = args({ options: { ...DEFAULT_RENDER_OPTIONS, mode: "list", showFilterUI: true }, onFilterChange });
    renderTimeline(a as never);
    expect(a.container.querySelector(".txs-filter-empty-hint")).toBeNull();
    const search = a.container.querySelector<HTMLInputElement>("input[type=search]")!;
    type(search, "no such thing");
    vi.advanceTimersByTime(250);
    expect(a.container.querySelector(".txs-filter-empty-hint")?.textContent).toContain("Filters are hiding all events");
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    const [yearFrom, yearTo] = [...a.container.querySelectorAll<HTMLInputElement>("input[placeholder=year]")];
    type(search, "");
    type(yearFrom, "1400");
    type(yearTo, "1600");
    type(a.container.querySelector(".txs-filter-zoom-input")!, "2");
    vi.advanceTimersByTime(250);
    expect(a.container.querySelectorAll(".txs-timeline-list > li")).toHaveLength(1);
  });

  it("uses an explicit viewport when there is no filter range", () => {
    const a = args({ viewport: { start: { year: 0 }, end: { year: 3000 } } });
    expect(() => renderTimeline(a as never)).not.toThrow();
  });

  it("reapplies stored filters on first render", () => {
    writeDevice("richfilter:idx", { hiddenCategories: ["B"], search: "", labels: [], start: { year: 1 }, end: { year: 3000 }, zoom: 3 });
    const a = args({ options: { ...DEFAULT_RENDER_OPTIONS, mode: "list", showFilterUI: true } });
    renderTimeline(a as never);
    expect(a.container.querySelectorAll(".txs-timeline-list > li")).toHaveLength(1);
  });
});
