// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Platform } from "../testUtils/obsidian";
import type { RenderArgs } from "../src/renderer";
import type { RichFilterState } from "../src/renderer/filter-bar";
import { makeTimelineProcessor, parseBlockOptions } from "../src/obsidian/markdown-postprocessor";
import { TimelineCache } from "../src/obsidian/cache";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { DEFAULT_SETTINGS, type TimelineXmlSyncSettings } from "../src/settings";
import { DEFAULT_RENDER_OPTIONS } from "../src/renderer/render-options";
import type { TimelineDoc, TimelineEvent } from "../src/timeline/model";
import { FakeApp } from "../testUtils/fake-app";
import { isUntouched, withContentHash } from "../src/obsidian/sync-policy";

const rendered: RenderArgs[] = [];
vi.mock("../src/renderer", async (orig) => ({
  ...(await orig<typeof import("../src/renderer")>()),
  renderTimeline: (args: RenderArgs) => {
    rendered.push(args);
    args.container.createDiv({ cls: "fake-render" });
  },
}));

const d = (year: number) => ({ year });
const ev = (id: string, a: number, b: number, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, text: `Event ${id}`, start: d(a), end: d(b), isPoint: a === b, ...over,
});
const doc = (events: TimelineEvent[], extra: Partial<TimelineDoc> = {}): TimelineDoc => ({
  categories: [{ name: "War" }, { name: "Peace" }], events, ...extra,
});

let app: FakeApp;
let settings: TimelineXmlSyncSettings;
let cache: { getRenderDoc: ReturnType<typeof vi.fn>; getXml: ReturnType<typeof vi.fn> };
let onEventClick: Mock<(id: string) => void>;
let onEraClick: Mock<(id: string) => void>;
let appendSyncLog: ReturnType<typeof vi.fn>;

const run = async (source = "", sourcePath = "note.md") => {
  const proc = makeTimelineProcessor({
    app: app as never, vault: new VaultAdapter(app as never), cache: cache as unknown as TimelineCache,
    getSettings: () => settings, onEventClick: onEventClick as never, onEraClick: onEraClick as never,
    appendSyncLog: appendSyncLog as never,
  });
  const el = document.body.createDiv();
  const children: unknown[] = [];
  await proc(source, el, { sourcePath, addChild: (c: unknown) => children.push(c) } as never);
  await vi.waitFor(() => expect(el.querySelector(".fake-render, .txs-error")).not.toBeNull());
  return { el, children };
};
const last = () => rendered[rendered.length - 1];

beforeEach(() => {
  rendered.length = 0;
  document.body.innerHTML = "";
  app = new FakeApp();
  settings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", categoryColors: { War: "red" } };
  cache = { getRenderDoc: vi.fn(async () => doc([ev("a", 0, 10, { category: "War" }), ev("b", 100, 200, { category: "Peace", labels: ["x"] })])), getXml: vi.fn(async () => doc([ev("x", 1, 2)])) };
  onEventClick = vi.fn<(id: string) => void>();
  onEraClick = vi.fn<(id: string) => void>();
  appendSyncLog = vi.fn(async () => {});
  Platform.isMobile = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseBlockOptions", () => {
  it("reads every option", () => {
    const o = parseBlockOptions(
      [
        "mode: bar", "source: other", "sourceXml: x.timeline", "details: compact", "sort: category", "show: [title, 3, date]",
        "zoom: 3", "orientation: vertical", "pointPaddingYears: 7", "stickyLabels: false", "shortEventLabels: false",
        "showFilterUI: true", "events: [Rome, 4]", "range: [500, 100]", "labels: {include: [a], exclude: [b]}",
        "search: rome", "viewport: true", "categories: {include: [W], exclude: [P]}",
      ].join("\n"),
    );
    expect(o).toMatchObject({
      mode: "bar", source: "other", sourceXmlOverride: "x.timeline", details: "compact", sort: "category", show: ["title", "date"],
      zoom: 3, orientation: "vertical", pointPaddingYears: 7, stickyLabels: false, shortEventLabels: false, showFilterUI: true,
      eventNames: ["Rome"], rangeYears: [100, 500], labelsInclude: ["a"], labelsExclude: ["b"], search: "rome", useViewport: true,
      categoryInclude: ["W"], categoryExclude: ["P"],
    });
  });

  it("supports the single-event and useViewport spellings", () => {
    expect(parseBlockOptions("event: Rome").eventNames).toEqual(["Rome"]);
    expect(parseBlockOptions("useViewport: false").useViewport).toBe(false);
  });

  it("falls back to the defaults for junk", () => {
    for (const src of ["", "- a\n- b", "just text", "key: [oops", "42"]) expect(parseBlockOptions(src)).toEqual(DEFAULT_RENDER_OPTIONS);
    const bad = parseBlockOptions("zoom: 0\norientation: sideways\npointPaddingYears: .nan\nrange: [1]\nrange2: x\nlabels: {include: 3}\ncategories: {exclude: x}");
    expect(bad).toEqual(DEFAULT_RENDER_OPTIONS);
    expect(parseBlockOptions("range: [a, 2]").rangeYears).toBeUndefined();
    expect(parseBlockOptions("zoom: 2", { ...DEFAULT_RENDER_OPTIONS, zoom: 9 }).zoom).toBe(2);
  });
});

describe("rendering", () => {
  it("shows a placeholder, then renders once the block has scrolled into view", async () => {
    const observed: Array<{ cb: (e: unknown[]) => void; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(public cb: (e: unknown[]) => void) {
        observed.push(this);
      }
    });
    const proc = makeTimelineProcessor({ app: app as never, vault: new VaultAdapter(app as never), cache: cache as never, getSettings: () => settings, onEventClick, onEraClick });
    const el = document.body.createDiv();
    const registered: Array<() => void> = [];
    await proc("", el, { sourcePath: "n.md", addChild: (c: { register: (fn: () => void) => void }) => (c.register = (fn) => registered.push(fn)) } as never);
    expect(el.textContent).toBe("Timeline loading…");
    observed[0].cb([{ isIntersecting: false }]);
    expect(el.textContent).toBe("Timeline loading…");
    observed[0].cb([{ isIntersecting: false }, { isIntersecting: true }]);
    await vi.waitFor(() => expect(el.querySelector(".fake-render")).not.toBeNull());
    expect(observed[0].disconnect).toHaveBeenCalled();
    observed[0].disconnect.mockClear();
    registered.forEach((fn) => fn()); // the render child's clean-up
    expect(observed[0].disconnect).toHaveBeenCalled();
  });

  it("passes colours, filters, precision and click routers to the renderer", async () => {
    settings.hiddenCategories = ["Hidden"];
    Platform.isMobile = true;
    await run("categories:\n  include: [War]\n  exclude: [Gone]");
    const a = last();
    expect(a.events.map((e) => e.id)).toEqual(["a"]);
    expect(a.initialHidden.sort()).toEqual(["Gone", "Hidden", "Peace"]);
    expect(a.isMobile).toBe(true);
    expect(a.categoryColors).toEqual({ War: "red" });
    expect(a.filterKey).toBe("main");
    a.onOpenEvent("a");
    a.onOpenEra?.("e");
    expect(onEventClick).toHaveBeenCalledWith("a");
    expect(onEraClick).toHaveBeenCalledWith("e");
    expect(a.viewport).toEqual({ start: d(0), end: d(10) });
  });

  it("uses the filter key 'default' when the block has no source", async () => {
    settings.renderDefaults = { ...settings.renderDefaults, source: "" };
    await run();
    expect(last().filterKey).toBe("default");
  });

  it("applies every event filter", async () => {
    cache.getRenderDoc.mockResolvedValue(
      doc([
        ev("a", 0, 10, { category: "War", labels: ["x"], description: "siege" }),
        ev("b", 100, 200, { category: "Peace", labels: ["y"] }),
        ev("c", 300, 400),
      ]),
    );
    const ids = async (src: string) => (await run(src), last().events.map((e) => e.id));
    expect(await ids("categories: {exclude: [War]}")).toEqual(["b", "c"]);
    expect(await ids("search: SIEGE")).toEqual(["a"]);
    expect(await ids("search: '   '")).toEqual(["a", "b", "c"]);
    expect(await ids("events: [event b]")).toEqual(["b"]);
    expect(await ids("range: [150, 350]")).toEqual(["b", "c"]);
    expect(await ids("labels: {include: [x]}")).toEqual(["a"]);
    expect(await ids("labels: {exclude: [x]}")).toEqual(["b", "c"]);
  });

  it("explains an empty result and read failures", async () => {
    cache.getRenderDoc.mockResolvedValue(doc([]));
    expect((await run()).el.textContent).toContain("No events found.");
    cache.getRenderDoc.mockRejectedValue(new Error("boom"));
    expect((await run()).el.textContent).toBe("Timeline error: boom");
  });

  it("reads an overriding XML directly when it exists, else the merged document", async () => {
    app.vault.seed("other.timeline", "");
    await run("sourceXml: other.timeline");
    expect(cache.getXml).toHaveBeenCalledWith("other.timeline");
    cache.getXml.mockClear();
    await run("sourceXml: missing.timeline");
    expect(cache.getXml).not.toHaveBeenCalled();
    settings.sourceXmlPath = "";
    await run();
    expect(cache.getRenderDoc).toHaveBeenCalled();
  });

  it("reports an unexpected error from inside the render", async () => {
    vi.spyOn(app.vault, "getAbstractFileByPath").mockImplementation(() => {
      throw new Error("vault exploded");
    });
    expect((await run()).el.textContent).toBe("Timeline error: vault exploded");
  });
});

describe("viewport policy", () => {
  const note = (fm: Record<string, unknown>) => {
    app.vault.seed("note.md", "");
    app.index("note.md", fm);
  };

  it("does not restrict by default, even on an event note", async () => {
    note({ timeline: { role: "event", start: { year: 100 }, end: { year: 200 } } });
    await run();
    expect(last().events).toHaveLength(2);
  });

  it("uses the host note's range when it is a viewport note, or the block asks for it", async () => {
    note({ timeline: { role: "viewport", start: { year: 90 }, end: { year: 250, month: 2, day: 3, hour: 1, minute: 2, second: 3 } } });
    await run();
    expect(last().events.map((e) => e.id)).toEqual(["b"]);
    expect(last().viewport?.end).toEqual({ year: 250, month: 2, day: 3, hour: 1, minute: 2, second: 3 });
    await run("viewport: false");
    expect(last().events).toHaveLength(2);
    app.vault.remove("note.md");
    note({ timeline: { start: { year: 0 }, end: { year: 5 } } });
    await run("viewport: true");
    expect(last().events.map((e) => e.id)).toEqual(["a"]);
  });

  it("pads a single-point range, and respects the padding settings", async () => {
    note({ timeline: { start: { year: 100 }, end: { year: 100 } } });
    settings.pointPaddingYears = 50;
    await run("viewport: true");
    expect(last().viewport).toEqual({ start: d(50), end: d(150) });
    await run("viewport: true\npointPaddingYears: 0");
    expect(last().viewport).toEqual({ start: d(100), end: d(100) });
    await run("viewport: true\npointPaddingYears: 2.7");
    expect(last().viewport).toEqual({ start: d(98), end: d(102) });
  });

  it("accepts scalar dates, rejects malformed ones, and falls back to the XML's displayed period", async () => {
    note({ timeline: { start: "0100-01-01", end: "0200-01-01" } });
    await run("viewport: true");
    expect(last().viewport).toEqual({ start: { year: 100, month: 1, day: 1, hour: undefined, minute: undefined, second: undefined }, end: { year: 200, month: 1, day: 1, hour: undefined, minute: undefined, second: undefined } });
    for (const fm of [{ timeline: { start: null, end: { year: 5 } } }, { timeline: { start: { month: 1 }, end: { year: 5 } } }, { timeline: [1] }, {}, undefined]) {
      app.vault.remove("note.md");
      note(fm as never);
      cache.getRenderDoc.mockResolvedValue(doc([ev("a", 0, 10)], { view: { displayedPeriod: { start: d(0), end: d(50) } } }));
      await run("viewport: true");
      expect(last().viewport).toEqual({ start: d(0), end: d(50) });
    }
  });

  it("auto-fits to the events when the host cannot say, or there is no host", async () => {
    await run("viewport: true", "");
    expect(last().viewport).toEqual({ start: d(0), end: d(200) });
    await run("viewport: true", "missing.md");
    expect(last().viewport).toEqual({ start: d(0), end: d(200) });
    note(undefined as never);
    await run();
    expect(last().viewport).toEqual({ start: d(0), end: d(200) });
  });

  it("treats a host without a usable timeline block as an ordinary note", async () => {
    note({ timeline: "viewport" });
    await run();
    expect(last().events).toHaveLength(2);
    app.vault.remove("note.md");
    app.vault.seed("note.md", "");
    await run(); // no metadata at all
    expect(last().events).toHaveLength(2);
  });
});

describe("persisting filter changes into the block", () => {
  const state = (over: Partial<RichFilterState> = {}): RichFilterState => ({
    hiddenCategories: new Set(), search: "", labels: [], start: null, end: null, zoom: null, ...over,
  });
  const fence = (body: string) => `intro\n\`\`\`timeline\n${body}\n\`\`\`\noutro`;
  const change = async (s: RichFilterState) => {
    last().onFilterChange?.(s);
    await vi.advanceTimersByTimeAsync(600);
  };

  beforeEach(() => {
    app.vault.seed("note.md", fence("mode: bar"));
  });

  it("writes search, labels, hidden categories, range and zoom back into the fenced block", async () => {
    await run("mode: bar");
    vi.useFakeTimers();
    await change(state({ search: " rome ", labels: ["a"], hiddenCategories: new Set(["War"]), start: d(1), end: d(5), zoom: 3 }));
    const text = app.vault.text("note.md");
    expect(text).toContain("search: rome");
    expect(text).toContain("include:\n    - a");
    expect(text).toContain("exclude:\n    - War");
    expect(text).toContain("range:\n  - 1\n  - 5");
    expect(text).toContain("zoom: 3");
    await change(state()); // clear everything again
    expect(app.vault.text("note.md")).toBe(fence("mode: bar"));
  });

  it("keeps the options the user typed and chains successive edits", async () => {
    app.vault.seed("note.md", fence("mode: bar\nzoom: 2\nlabels:\n  exclude: [z]\ncategories:\n  include: [W]"));
    await run("mode: bar\nzoom: 2\nlabels:\n  exclude: [z]\ncategories:\n  include: [W]");
    vi.useFakeTimers();
    await change(state({ search: "a" }));
    await change(state({ search: "b" }));
    const text = app.vault.text("note.md");
    expect(text).toContain("search: b");
    expect(text).toContain("exclude:\n    - z");
    expect(text).toContain("include:\n    - W");
    expect(text).toContain("zoom: 2"); // the author's zoom survives a filter change
    await change(state({ search: "b", zoom: 5 }));
    expect(app.vault.text("note.md")).toContain("zoom: 5");
    await change(state({ search: "b", zoom: null })); // override cleared: the author's value is back
    expect(app.vault.text("note.md")).toContain("zoom: 2");
  });

  it("writes search text containing replacement patterns literally", async () => {
    await run("mode: bar");
    vi.useFakeTimers();
    await change(state({ search: "US$$ $& it's $'" }));
    expect(app.vault.text("note.md")).toContain("search: US$$ $& it's $'");
    expect(app.vault.text("note.md").startsWith("intro\n```timeline\n")).toBe(true);
    expect(app.vault.text("note.md").endsWith("\n```\noutro")).toBe(true);
  });

  it("keeps an untouched event note untouched-looking when the chart persists its filter", async () => {
    const sealed = withContentHash("---\ntitle: x\n---\n\n```timeline\nmode: bar\n```\n");
    app.vault.seed("note.md", sealed);
    await run("mode: bar");
    vi.useFakeTimers();
    await change(state({ search: "rome" }));
    const after = app.vault.text("note.md");
    expect(after).toContain("search: rome");
    expect(isUntouched(after)).toBe(true); // the plugin's own UI state is not a user edit
    // a note the user had already edited stays "edited"
    app.vault.seed("note.md", sealed + "my words\n");
    await change(state({ search: "athens" }));
    expect(isUntouched(app.vault.text("note.md"))).toBe(false);
  });

  it("drops an override it wrote when the block never had a zoom", async () => {
    await run("mode: bar");
    vi.useFakeTimers();
    await change(state({ zoom: 4 }));
    expect(app.vault.text("note.md")).toContain("zoom: 4");
    await change(state());
    expect(app.vault.text("note.md")).not.toContain("zoom:");
  });

  it("coalesces rapid changes into one write", async () => {
    await run("mode: bar");
    vi.useFakeTimers();
    const spy = vi.spyOn(app.vault, "process");
    last().onFilterChange?.(state({ search: "a" }));
    await vi.advanceTimersByTimeAsync(300);
    last().onFilterChange?.(state({ search: "ab" }));
    await vi.advanceTimersByTimeAsync(600);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(app.vault.text("note.md")).toContain("search: ab");
  });

  it("does nothing when there is no note, the note is gone, or nothing changed", async () => {
    await run("mode: bar", "");
    vi.useFakeTimers();
    const spy = vi.spyOn(app.vault, "process");
    await change(state({ search: "a" }));
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
    await run("mode: bar", "gone.md");
    vi.useFakeTimers();
    await change(state({ search: "a" }));
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
    await run("mode: bar");
    vi.useFakeTimers();
    await change(state());
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-reads the note when another device rewrote the block, then retries against it", async () => {
    await run("mode: bar");
    app.vault.seed("note.md", fence("mode: list"));
    vi.useFakeTimers();
    await change(state({ search: "q" }));
    expect(app.vault.text("note.md")).toContain("mode: list");
    expect(app.vault.text("note.md")).toContain("search: q");
    expect(appendSyncLog).not.toHaveBeenCalled();
  });

  it("gives up (and logs) when the retried write is lost too", async () => {
    await run("mode: bar");
    app.vault.seed("note.md", fence("mode: list"));
    vi.useFakeTimers();
    vi.spyOn(app.vault, "process").mockRejectedValue(new Error("busy"));
    await change(state({ search: "q" }));
    expect(appendSyncLog).toHaveBeenCalledWith("filter-persist-failed", "note.md", expect.any(String));
  });

  it("accepts a block that already says what we wanted", async () => {
    await run("mode: bar");
    app.vault.seed("note.md", fence("mode: list\nsearch: q"));
    vi.useFakeTimers();
    await change(state({ search: "q" }));
    expect(appendSyncLog).not.toHaveBeenCalled();
    await change(state({ search: "q2" })); // baseline moved to the other device's body
    expect(app.vault.text("note.md")).toContain("search: q2");
  });

  it("logs when it can no longer find the block, and tolerates read or write failures", async () => {
    await run("mode: bar");
    app.vault.seed("note.md", "the block is gone");
    vi.useFakeTimers();
    await change(state({ search: "q" }));
    expect(appendSyncLog).toHaveBeenCalledWith("filter-persist-failed", "note.md", expect.any(String));
    appendSyncLog.mockClear();

    app.vault.seed("note.md", fence("mode: list"));
    app.vault.failNext.set("process", new Error("busy"));
    await change(state({ search: "r" })); // first replace throws, retry works
    expect(app.vault.text("note.md")).toContain("search: r");

    app.vault.seed("note.md", "no block");
    app.vault.failNext.set("read", new Error("unreadable"));
    await change(state({ search: "s" }));
    expect(appendSyncLog).toHaveBeenCalledTimes(1);
  });

  it("works without a sync log", async () => {
    const proc = makeTimelineProcessor({ app: app as never, vault: new VaultAdapter(app as never), cache: cache as never, getSettings: () => settings, onEventClick, onEraClick });
    const el = document.body.createDiv();
    await proc("mode: bar", el, { sourcePath: "note.md", addChild: () => {} } as never);
    await vi.waitFor(() => expect(el.querySelector(".fake-render")).not.toBeNull());
    app.vault.seed("note.md", "gone");
    vi.useFakeTimers();
    await change(state({ search: "z" }));
  });

  it("copes with a block body that is not a mapping", async () => {
    app.vault.seed("note.md", fence("- a\n- b"));
    await run("- a\n- b");
    vi.useFakeTimers();
    await change(state({ search: "k" }));
    expect(app.vault.text("note.md")).toContain("search: k");
    app.vault.seed("note.md", fence("key: [oops"));
    await run("key: [oops");
    await change(state({ search: "k2" }));
    expect(app.vault.text("note.md")).toContain("search: k2");
  });
});
