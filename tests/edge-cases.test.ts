// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice, Plugin, TFile } from "../testUtils/obsidian";
import { importXml, loadAllNotes, regenerateXml, wipeAndReimport, type CommandsContext } from "../src/obsidian/commands";
import { TimelineCache } from "../src/obsidian/cache";
import { TemplateService } from "../src/obsidian/template-service";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { DEFAULT_SETTINGS, isBackupPath, isInsideFolder, type TimelineXmlSyncSettings } from "../src/settings";
import { setLogLevel } from "../src/logger";
import { safeFileName, slugify } from "../src/timeline/id-utils";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { parseEventNote } from "../src/timeline/markdown-parser";
import { parseEraNote, renderEraMarkdown } from "../src/timeline/era-md";
import { validateEventNote } from "../src/timeline/validator";
import type { EventNote } from "../src/timeline/model";
import { FakeApp } from "../testUtils/fake-app";

const note = (id: string) =>
  `---\ntitle: ${id}\ntimeline:\n  enabled: true\n  event_id: ${id}\n  start: {year: 10}\n  end: {year: 20}\n---\n# ${id}\n`;

const xml = (events: string) =>
  `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version><categories/><events>${events}</events></timeline>`;

describe("slugify for non-Latin titles", () => {
  it("keeps the letters of scripts with no ASCII equivalent", () => {
    expect(slugify("Δαβίδ")).toBe("δαβιδ");
    expect(slugify("דוד המלך")).toBe("דוד-המלך");
    expect(slugify("北京")).toBe("北京");
    expect(slugify("Δαβίδ") === slugify("Σολομών")).toBe(false);
  });

  it("leaves ids that already worked untouched", () => {
    expect(slugify("Hezekiah's reign")).toBe("hezekiah-s-reign");
    expect(slugify("Čas králů")).toBe("cas-kralu");
    expect(slugify("Δαβίδ king")).toBe("king");
  });

  it("still falls back to a constant for symbols only", () => {
    expect(slugify("???")).toBe("event");
    expect(slugify("")).toBe("event");
  });

  it("caps the length without splitting a character", () => {
    const long = "𠀀".repeat(120);
    const out = slugify(long, 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(slugify(`${"字".repeat(9)} ${"字".repeat(5)}`, 10)).toBe("字".repeat(9));
  });

  it("gives distinct ids to distinct non-Latin events in one XML", () => {
    const doc = parseTimelineXml(
      xml(
        `<event><start>0100-01-01</start><end>0100-01-01</end><text>Δαβίδ</text></event>` +
          `<event><start>0200-01-01</start><end>0200-01-01</end><text>Σολομών</text></event>`
      )
    );
    expect(doc.events.map((e) => e.id)).toEqual(["δαβιδ", "σολομων"]);
  });
});

describe("safeFileName", () => {
  it("passes ordinary ids through", () => {
    expect(safeFileName("battle-of-hastings-1066")).toBe("battle-of-hastings-1066");
    expect(safeFileName("-1")).toBe("-1");
  });
  it("replaces separators and reserved characters", () => {
    expect(safeFileName("a/b\\c:d")).toBe("a-b-c-d");
    expect(safeFileName("what? [1] #2 ^3")).toBe("what-1-2-3");
  });
  it("never produces a hidden or empty name", () => {
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("///")).toBe("-");
    expect(safeFileName("  ")).toBe("event");
    expect(safeFileName("")).toBe("event");
  });
});

describe("XML numbers and points", () => {
  it("reads an empty progress element as no progress, not 0 %", () => {
    const doc = parseTimelineXml(
      xml(`<event id="a"><start>0100-01-01</start><end>0200-01-01</end><text>A</text><progress></progress></event>` +
        `<event id="b"><start>0100-01-01</start><end>0200-01-01</end><text>B</text><progress>  </progress></event>` +
        `<event id="c"><start>0100-01-01</start><end>0200-01-01</end><text>C</text><progress>40</progress></event>`)
    );
    expect(doc.events.map((e) => e.progress)).toEqual([undefined, undefined, 40]);
  });

  it("treats an omitted day as day 1 when deciding whether an event is a point", () => {
    const ok = parseTimelineXml(
      xml(`<event id="a"><start>0100-01</start><end>0100-01-01 00:00:00</end><text>A</text></event>`)
    );
    expect(ok.events[0].isPoint).toBe(true);
  });

  it("agrees between a note and the XML it came from", () => {
    const md = `---\ntimeline:\n  enabled: true\n  event_id: p\n  start: {year: 5, month: 1}\n  end: {year: 5, month: 1, day: 1, hour: 0}\n---\n# P\n`;
    expect(parseEventNote(md, { path: "p.md" }).note?.event.isPoint).toBe(true);
  });
});

describe("validator", () => {
  const mk = (start: EventNote["event"]["start"], end = start): EventNote => ({
    event: { id: "x", text: "X", start, end, isPoint: false },
    location: { path: "x.md" },
    extraFrontmatter: {},
    body: "",
    mirrors: {},
  });

  it("checks a day that has no month against January", () => {
    expect(validateEventNote(mk({ year: 2000, day: 40 })).errors.map((e) => e.message)).toEqual([
      "timeline.start.day 40 invalid for 2000-1 (max 31)",
      "timeline.end.day 40 invalid for 2000-1 (max 31)",
    ]);
    expect(validateEventNote(mk({ year: 2000, day: 15 })).ok).toBe(true);
  });

  it("reports an impossible month once, without a bogus day error", () => {
    const r = validateEventNote(mk({ year: 2000, month: 13, day: 5 }));
    expect(r.errors.map((e) => e.message)).toEqual(["timeline.start.month must be 1..12", "timeline.end.month must be 1..12"]);
    expect(validateEventNote(mk({ year: 2000, month: 0, day: 5 })).errors).toHaveLength(2);
  });
});

describe("era notes survive awkward text", () => {
  const era = (over: Partial<Parameters<typeof renderEraMarkdown>[0]> = {}) => ({
    id: "e1",
    name: "Iron age",
    start: { year: 100 },
    end: { year: 200 },
    color: "rgb(1,2,3)",
    ...over,
  });
  const roundTrip = (name: string, xmlPath = "t.timeline", tid = "main") => {
    const md = renderEraMarkdown(era({ name }), tid, xmlPath, 5);
    return parseEraNote(md, "fallback");
  };

  it.each(["1066", "null", "Yes", "true", "~", "Era: the sequel", "Era # one", "Δαβίδ", "Line one\nline two", '"quoted"', "- dash"])(
    "keeps the name %j",
    (name) => {
      expect(roundTrip(name)?.name).toBe(name);
    }
  );

  it("still reads a plain name and an empty colour", () => {
    expect(roundTrip("Iron age (early)")?.name).toBe("Iron age (early)");
    const md = renderEraMarkdown(era({ color: undefined }), "main", "t.timeline");
    expect(parseEraNote(md, "f")?.color).toBeUndefined();
  });

  it("copes with an XML path that YAML would misread", () => {
    expect(roundTrip("Iron age", "My timelines/Bible #1: kings.timeline", "my timeline: v2")?.start.year).toBe(100);
    const md = renderEraMarkdown(era(), "main", "a #b.timeline");
    expect(md).toContain('source_xml: "a #b.timeline"');
  });
});

describe("backup folders", () => {
  const s = (over: Partial<TimelineXmlSyncSettings> = {}) => ({ ...DEFAULT_SETTINGS, eventNotesDir: "Events", ...over });

  it("recognises a folder and what is inside it", () => {
    expect(isInsideFolder("a/b/c.md", "a/b")).toBe(true);
    expect(isInsideFolder("a/b", "a/b")).toBe(true);
    expect(isInsideFolder("a/bc/c.md", "a/b")).toBe(false);
    expect(isInsideFolder("a/b/c.md", "/a\\b/")).toBe(true);
    expect(isInsideFolder("a.md", "/")).toBe(false);
  });

  it("uses the default and the configured backup folder", () => {
    expect(isBackupPath(s(), "Events/_backups/wipe-1/a.md")).toBe(true);
    expect(isBackupPath(s(), "Events/a.md")).toBe(false);
    expect(isBackupPath(s({ backupFolder: "Safe" }), "Safe/x/a.md")).toBe(true);
    expect(isBackupPath(s({ backupFolder: "Safe" }), "Events/_backups/a.md")).toBe(false);
  });
});

describe("backups inside the notes folder", () => {
  let app: FakeApp;
  let settings: TimelineXmlSyncSettings;
  let ctx: CommandsContext;
  let cache: TimelineCache;
  let vault: VaultAdapter;

  beforeEach(() => {
    Notice.reset();
    setLogLevel("error");
    app = new FakeApp();
    settings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", templatesDir: "Templates", timelineId: "main", backupRetention: 3 };
    vault = new VaultAdapter(app as never);
    cache = new TimelineCache(app as never, () => settings);
    ctx = {
      app: app as never,
      plugin: new Plugin(app) as never,
      vault,
      templates: new TemplateService(app as never, vault, () => settings),
      cache,
      getSettings: () => settings,
      saveSettings: async () => {},
      withSelfWrite: async (fn) => fn(),
      setDiagnostics: () => {},
      getDiagnostics: () => [],
      createEventInteractive: vi.fn(async () => {}),
      appendSyncLog: async () => {},
    };
  });

  const seedXml = () =>
    app.vault.seed("t.timeline", xml(`<event id="a"><start>0100-01-01</start><end>0200-01-01</end><text>Alpha</text></event>`), 50);

  it("wipe-and-reimport leaves the snapshot it just took intact", async () => {
    seedXml();
    await importXml(ctx);
    const before = app.vault.text("Events/a.md");
    await wipeAndReimport(ctx);
    const snapshots = app.vault.getFiles().filter((f) => f.path.startsWith("Events/_backups/wipe-") && f.extension === "md");
    const copy = snapshots.find((f) => f.name === "a.md");
    expect(copy).toBeDefined();
    expect(app.vault.text(copy!.path)).toBe(before);
    expect(app.trashed.some((p) => p.startsWith("Events/_backups/"))).toBe(false);
  });

  it("does not copy earlier snapshots into the next one", async () => {
    seedXml();
    await importXml(ctx);
    await wipeAndReimport(ctx);
    await new Promise((r) => setTimeout(r, 3));
    await wipeAndReimport(ctx);
    const files = app.vault.getFiles().map((f) => f.path).filter((p) => p.includes("_backups/wipe-") && p.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((p) => p.includes("_backups/wipe-") && p.split("_backups/").length > 2)).toBe(false);
  });

  it("does not read snapshots as live notes", async () => {
    seedXml();
    await importXml(ctx);
    await wipeAndReimport(ctx);
    expect((await loadAllNotes(ctx)).notes.map((n) => n.event.id)).toEqual(["a"]);
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).events.map((e) => e.id)).toEqual(["a"]);
    expect(Notice.messages().some((m) => m.includes("refusing to write XML"))).toBe(false);
  });

  it("keeps snapshots out of the id index and the rendered document", async () => {
    app.vault.seed("Events/a.md", note("a"));
    app.vault.seed("Events/_backups/wipe-1/a.md", note("a"));
    app.vault.seed("Events/_backups/wipe-1/ghost.md", note("ghost"));
    app.index("Events/a.md", { timeline: { event_id: "a" } });
    app.index("Events/_backups/wipe-1/a.md", { timeline: { event_id: "a" } });
    app.index("Events/_backups/wipe-1/ghost.md", { timeline: { event_id: "ghost" } });
    expect(cache.resolvePath("a")).toBe("Events/a.md");
    expect(cache.resolvePath("ghost")).toBeNull();
    cache.updateFile("Events/_backups/wipe-1/ghost.md");
    expect(cache.resolvePath("ghost")).toBeNull();
    cache.invalidateMdDoc();
    expect((await cache.getMdDoc()).events.map((e) => e.id)).toEqual(["a"]);
  });

  it("lists markdown files minus an excluded folder", () => {
    app.vault.seed("Events/a.md", "");
    app.vault.seed("Events/_backups/x/a.md", "");
    expect(vault.listMarkdownFiles("Events").map((f) => f.path)).toEqual(["Events/a.md", "Events/_backups/x/a.md"]);
    expect(vault.listMarkdownFiles("Events", "Events/_backups").map((f) => f.path)).toEqual(["Events/a.md"]);
    expect(vault.listMarkdownFiles("Events", "Events/a.md").map((f) => f.path)).toEqual(["Events/_backups/x/a.md"]);
  });
});

describe("importing ids that are not file names", () => {
  it("writes a note per event even when the XML id holds a slash or colon", async () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main" };
    const vault = new VaultAdapter(app as never);
    const ctx = {
      app: app as never,
      plugin: new Plugin(app) as never,
      vault,
      templates: new TemplateService(app as never, vault, () => settings),
      cache: new TimelineCache(app as never, () => settings),
      getSettings: () => settings,
      saveSettings: async () => {},
      withSelfWrite: async (fn: () => Promise<unknown>) => fn(),
      setDiagnostics: () => {},
      getDiagnostics: () => [],
      createEventInteractive: vi.fn(async () => {}),
      appendSyncLog: async () => {},
    } as unknown as CommandsContext;
    app.vault.seed(
      "t.timeline",
      xml(`<event id="kings/david: 1"><start>0100-01-01</start><end>0200-01-01</end><text>David</text></event>`),
      50
    );
    await importXml(ctx);
    const paths = app.vault.getFiles().map((f) => f.path);
    expect(paths).toContain("Events/kings-david-1.md");
    expect(paths.some((p) => p.startsWith("Events/kings/"))).toBe(false);
    const parsed = parseEventNote(app.vault.text("Events/kings-david-1.md"), { path: "x" });
    expect(parsed.note?.event.id).toBe("kings/david: 1");
    expect(app.vault.files.get("Events/kings-david-1.md")).toBeInstanceOf(TFile);
  });
});

describe("events that are switched off or run to today", () => {
  const ev = (id: string, over = "") =>
    `---\ntimeline:\n  enabled: true\n  event_id: ${id}\n  start: {year: 1900}\n  end: {year: 1950}\n${over}---\n# ${id}\n`;
  const run = async (eventSource: "xml" | "md" | "auto", files: Record<string, string>, xmlText?: string) => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", eventSource };
    if (xmlText) app.vault.seed("t.timeline", xmlText, 5);
    for (const [p, c] of Object.entries(files)) app.vault.seed(p, c);
    return new TimelineCache(app as never, () => settings).getRenderDoc();
  };

  it("leaves out events with render off, from every source", async () => {
    const notes = { "Events/a.md": ev("a"), "Events/b.md": ev("b", "  render: false\n") };
    expect((await run("md", notes)).events.map((e) => e.id)).toEqual(["a"]);
    expect((await run("auto", notes)).events.map((e) => e.id)).toEqual(["a"]);
    const x = xml(`<event id="b"><start>0100-01-01</start><end>0200-01-01</end><text>B</text></event>`);
    // A note that turns an XML event off hides it too.
    expect((await run("auto", { "Events/b.md": ev("b", "  render: false\n") }, x)).events).toEqual([]);
    expect((await run("xml", {}, x)).events.map((e) => e.id)).toEqual(["b"]);
  });

  it("stretches an event that ends today to today, without touching the cache", async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 5, 12) });
    try {
      const app = new FakeApp();
      const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", eventSource: "md" };
      app.vault.seed("Events/open.md", ev("open", "  ends_today: true\n"));
      app.vault.seed("Events/future.md", `---\ntimeline:\n  enabled: true\n  event_id: future\n  ends_today: true\n  start: {year: 3000}\n  end: {year: 3001}\n---\n`);
      app.vault.seed("Events/now.md", `---\ntimeline:\n  enabled: true\n  event_id: now\n  ends_today: true\n  start: {year: 2026, month: 11, day: 5}\n  end: {year: 2026, month: 11, day: 5}\n---\n`);
      const cache = new TimelineCache(app as never, () => settings);
      const shown = (await cache.getRenderDoc()).events;
      const byId = Object.fromEntries(shown.map((e) => [e.id, e]));
      expect(byId.open.end).toEqual({ year: 2026, month: 11, day: 5 });
      expect(byId.open.isPoint).toBe(false);
      expect(byId.now.isPoint).toBe(true);
      expect(byId.future.end).toEqual({ year: 3001, month: undefined, day: undefined, hour: undefined, minute: undefined, second: undefined });
      expect((await cache.getMdDoc()).events.find((e) => e.id === "open")?.end.year).toBe(1950);
    } finally {
      vi.useRealTimers();
    }
  });
});
