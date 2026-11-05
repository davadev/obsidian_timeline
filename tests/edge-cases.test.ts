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
import { contentFingerprint, isUntouched, shouldSkipImportOverwrite, withContentHash } from "../src/obsidian/sync-policy";
import { findEraNotePath } from "../src/obsidian/era-files";
import { eventSourceKey } from "../src/timeline/event-source";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { writeTimelineXml } from "../src/timeline/xml-writer";
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

describe("regenerate and ordinary notes", () => {
  const setup = () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main", backupEnabled: false };
    const vault = new VaultAdapter(app as never);
    const log: string[] = [];
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
      appendSyncLog: async (e: string) => { log.push(e); },
    } as unknown as CommandsContext;
    return { app, ctx, log };
  };
  const X = xml(`<event id="a"><start>0100-01-01</start><end>0200-01-01</end><text>Alpha</text></event>`);

  it("is not blocked by a plain note dropped into the events folder", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", X, 50);
    await importXml(ctx);
    app.vault.seed("Events/README.md", "Just some words, no frontmatter.");
    app.vault.seed("Events/empty.md", "---\n---\nbody");
    await regenerateXml(ctx);
    expect(Notice.messages().some((m) => m.includes("refusing"))).toBe(false);
    expect(parseTimelineXml(app.vault.text("t.timeline")).events.map((e) => e.id)).toEqual(["a"]);
  });

  it("still refuses on broken YAML, which may be an event", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", X, 50);
    await importXml(ctx);
    app.vault.seed("Events/bad.md", "---\nkey: [oops\n---\n");
    await regenerateXml(ctx);
    expect(Notice.messages().some((m) => m.includes("refusing to write XML"))).toBe(true);
  });

  it("will not replace a XML that has events with one that has none", async () => {
    const { app, ctx, log } = setup();
    Notice.reset();
    app.vault.seed("t.timeline", X, 50);
    const before = app.vault.text("t.timeline");
    await regenerateXml(ctx); // the notes folder has not synced in
    expect(app.vault.text("t.timeline")).toBe(before);
    expect(Notice.messages()[0]).toContain("no event notes found");
    expect(log).toEqual(["regen-aborted-no-notes"]);
  });

  it("still writes a first XML when there is none", async () => {
    const { app, ctx } = setup();
    app.vault.seed("Events/a.md", note("a"));
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).events.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("content seal", () => {
  const md = "---\ntitle: x\n---\n\n# x\n";

  it("tells an untouched note from an edited or unsealed one", () => {
    const sealed = withContentHash(md);
    expect(sealed.startsWith("---\ntimeline_hash: ")).toBe(true);
    expect(isUntouched(sealed)).toBe(true);
    expect(isUntouched(sealed + "more")).toBe(false);
    expect(isUntouched(sealed.replace(/\n/g, "\r\n"))).toBe(false); // re-encoded: do not trust it
    expect(isUntouched(md)).toBeNull();
  });

  it("decides an import by the seal first and the timestamps second", () => {
    const sealed = withContentHash(md);
    expect(shouldSkipImportOverwrite(sealed, 999_999, 1)).toBe(false); // untouched, however old the stamp
    expect(shouldSkipImportOverwrite(sealed + "x", 1, 999_999)).toBe(true);
    expect(shouldSkipImportOverwrite(md, 10_000, 1)).toBe(true); // no seal, edited after the stamp
    expect(shouldSkipImportOverwrite(md, 1, 10_000)).toBe(false);
  });

  it("is not carried into a note the inspector re-renders", () => {
    const sealed = withContentHash(note("a"));
    const parsed = parseEventNote(sealed, { path: "a.md" });
    expect(parsed.note?.event.id).toBe("a");
    expect(parsed.note?.extraFrontmatter).not.toHaveProperty("timeline_hash");
  });
});

describe("regenerate leaves a settled XML alone", () => {
  const events = ["z", "a", "m"].map((id) => `<event id="${id}"><start>0100-01-01</start><end>0200-01-01</end><text>${id}</text></event>`).join("");
  const setup = () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main", backupEnabled: false };
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
    return { app, ctx };
  };

  it("keeps the XML's event order and does not rewrite identical bytes", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", xml(events), 50);
    await importXml(ctx);
    await regenerateXml(ctx); // first pass may normalise formatting
    const settled = app.vault.text("t.timeline");
    expect(parseTimelineXml(settled).events.map((e) => e.id)).toEqual(["z", "a", "m"]);
    const mtime = (app.vault.files.get("t.timeline") as TFile).stat.mtime;
    Notice.reset();
    await regenerateXml(ctx);
    expect(app.vault.text("t.timeline")).toBe(settled);
    expect((app.vault.files.get("t.timeline") as TFile).stat.mtime).toBe(mtime);
    expect(Notice.messages()).toEqual(["Timeline XML already up to date — 3 events."]);
  });

  it("appends a new note's event after the existing ones", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", xml(events), 50);
    await importXml(ctx);
    app.vault.seed("Events/0-new.md", note("new"));
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).events.map((e) => e.id)).toEqual(["z", "a", "m", "new"]);
  });

  it("applies metadata edits after its own earlier regenerate", async () => {
    const { app, ctx } = setup();
    app.vault.clock = 100_000; // well after the XML's own mtime, as in a real vault
    app.vault.seed("t.timeline", xml(events), 50);
    await importXml(ctx);
    app.vault.seed("Events/extra.md", note("extra")); // forces a real write, moving the XML's mtime past the metadata stamp
    await regenerateXml(ctx);
    Notice.reset();
    app.vault.seed("Events/extra2.md", note("extra2"));
    await regenerateXml(ctx);
    expect(Notice.messages().some((m) => m.includes("older than the XML"))).toBe(false);
  });
});

describe("import finds a note that was renamed", () => {
  it("updates the note where it is instead of writing a second one", async () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main" };
    const vault = new VaultAdapter(app as never);
    const cache = new TimelineCache(app as never, () => settings);
    const ctx = {
      app: app as never,
      plugin: new Plugin(app) as never,
      vault,
      templates: new TemplateService(app as never, vault, () => settings),
      cache,
      getSettings: () => settings,
      saveSettings: async () => {},
      withSelfWrite: async (fn: () => Promise<unknown>) => fn(),
      setDiagnostics: () => {},
      getDiagnostics: () => [],
      createEventInteractive: vi.fn(async () => {}),
      appendSyncLog: async () => {},
    } as unknown as CommandsContext;
    app.vault.seed("t.timeline", xml(`<event id="a"><start>0100-01-01</start><end>0200-01-01</end><text>Alpha</text></event>`), 50);
    await importXml(ctx);
    // The user renames the note and Obsidian re-indexes it.
    const old = app.vault.text("Events/a.md");
    app.vault.remove("Events/a.md");
    app.vault.seed("Events/Alpha, renamed.md", old);
    app.index("Events/Alpha, renamed.md", { timeline: { event_id: "a" } });
    cache.resetIndex();
    app.vault.seed("t.timeline", xml(`<event id="a"><start>0100-01-01</start><end>0200-01-01</end><text>Alpha two</text></event>`), 60);
    await importXml(ctx);
    expect(app.vault.files.has("Events/a.md")).toBe(false);
    expect(app.vault.text("Events/Alpha, renamed.md")).toContain("Alpha two");
  });
});

describe("notes and XML disagreeing", () => {
  const ev = (id: string, text = id) => `<event id="${id}"><start>0100-01-01</start><end>0200-01-01</end><text>${text}</text></event>`;
  const setup = () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main", backupEnabled: false };
    const vault = new VaultAdapter(app as never);
    const log: string[] = [];
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
      appendSyncLog: async (e: string) => { log.push(e); },
    } as unknown as CommandsContext;
    return { app, ctx, log, settings };
  };
  const setMtime = (app: FakeApp, p: string, m: number) => { (app.vault.files.get(p) as TFile).stat.mtime = m; };

  it("will not write stale notes over a XML that was edited since the import", async () => {
    const { app, ctx, log } = setup();
    app.vault.clock = 100_000;
    app.vault.seed("t.timeline", xml(ev("a") + ev("b")), 50);
    await importXml(ctx);
    // Saved in Timeline Project: event b deleted, a retitled.
    const edited = xml(ev("a", "A, retitled"));
    app.vault.seed("t.timeline", edited, 200_000);
    Notice.reset();
    await regenerateXml(ctx);
    expect(app.vault.text("t.timeline")).toBe(edited);
    expect(Notice.messages()[0]).toContain("changed since the last import");
    expect(log).toEqual(["regen-aborted-xml-newer"]);
    // After importing, the notes follow the XML and regenerate goes through.
    await importXml(ctx);
    Notice.reset();
    await regenerateXml(ctx);
    const out = parseTimelineXml(app.vault.text("t.timeline"));
    expect(out.events.map((e) => [e.id, e.text])).toEqual([["a", "A, retitled"]]);
  });

  it("does not mistake a sync client re-touching the file for an edit", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", xml(ev("a")), 50);
    await importXml(ctx);
    app.vault.seed("Events/new.md", note("new"));
    setMtime(app, "t.timeline", 900_000); // same bytes, new timestamp
    Notice.reset();
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).events.map((e) => e.id).sort()).toEqual(["a", "new"]);
  });

  it("does not overwrite a XML it cannot read to compare", async () => {
    const { app, ctx, log } = setup();
    app.vault.seed("t.timeline", xml(ev("a")), 50);
    await importXml(ctx);
    setMtime(app, "t.timeline", 900_000);
    app.vault.failNext.set("read", new Error("mid-sync"));
    await regenerateXml(ctx);
    expect(log).toEqual(["regen-aborted-xml-newer"]);
  });

  it("removes untouched notes whose event was deleted in the XML, and only those", async () => {
    const { app, ctx, log } = setup();
    app.vault.seed("t.timeline", xml(ev("a") + ev("b") + ev("c") + ev("d")), 50);
    await importXml(ctx);
    app.vault.seed("Events/b.md", app.vault.text("Events/b.md") + "\nmy own words\n"); // edited
    app.vault.seed("Events/d.md", app.vault.text("Events/d.md").replace(/^timeline_hash: .*\n/m, "")); // no seal
    app.vault.seed("Events/mine.md", note("mine")); // written by hand
    app.vault.seed("Events/plain.md", "just text");
    app.vault.seed("t.timeline", xml(ev("a")), 60);
    Notice.reset();
    await importXml(ctx);
    const left = app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith("Events/") && !p.includes("/_"));
    expect(left.sort()).toEqual(["Events/a.md", "Events/b.md", "Events/d.md", "Events/mine.md", "Events/plain.md"]);
    expect(app.trashed).toEqual(["Events/c.md"]);
    expect(Notice.messages().pop()).toContain("1 removed (deleted in the XML)");
    expect(log).toContain("import-removed");
  });

  it("reports removals in the skip summary too, and truncates the log list", async () => {
    const { app, ctx } = setup();
    const many = Array.from({ length: 12 }, (_, i) => ev(`e${i}`)).join("");
    app.vault.seed("t.timeline", xml(ev("a") + many), 50);
    await importXml(ctx);
    app.vault.seed("Events/a.md", app.vault.text("Events/a.md") + "\nedited\n");
    app.vault.seed("t.timeline", xml(ev("a")), 60);
    Notice.reset();
    await importXml(ctx);
    const msg = Notice.messages().pop()!;
    expect(msg).toContain("1 skipped (local edits), 12 removed (deleted in the XML)");
  });

  it("never empties the notes folder because the XML has no events", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", xml(ev("a") + ev("b")), 50);
    await importXml(ctx);
    app.vault.seed("t.timeline", xml(""), 60);
    await importXml(ctx);
    expect(app.vault.files.has("Events/a.md")).toBe(true);
    expect(app.vault.files.has("Events/b.md")).toBe(true);
  });

  it("copes with a note it cannot read while looking for removals", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", xml(ev("a")), 50);
    await importXml(ctx);
    app.vault.seed("Events/stuck.md", note("stuck"));
    setLogLevel("silent" as never);
    const read = vi.spyOn(VaultAdapter.prototype, "readText").mockImplementation(async function (this: VaultAdapter, p: string) {
      if (p === "Events/stuck.md") throw new Error("not downloaded");
      return app.vault.text(p);
    });
    await importXml(ctx);
    read.mockRestore();
    expect(app.vault.files.has("Events/stuck.md")).toBe(true);
  });
});

describe("events the parser cannot read", () => {
  const bad = `<event id="broken"><start>someday</start><end>0200-01-01</end><text>Broken</text><custom>keep me</custom></event>`;
  const good = `<event id="ok"><start>0100-01-01</start><end>0200-01-01</end><text>Fine</text></event>`;
  const badEra = `<era><name>Odd era</name><start>never</start><end>0500-01-01</end></era>`;
  const X = `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version><categories/><events>${bad}${good}</events><eras>${badEra}</eras></timeline>`;

  it("keeps them out of the model and in the file", () => {
    const doc = parseTimelineXml(X);
    expect(doc.events.map((e) => e.id)).toEqual(["ok"]);
    expect(doc.unparsedEvents).toHaveLength(1);
    expect(doc.unparsedEras).toHaveLength(1);
    expect(parseTimelineXml(xml(good)).unparsedEvents).toBeUndefined();
    const out = writeTimelineXml(doc);
    expect(out).toContain("someday");
    expect(out).toContain("keep me");
    expect(out).toContain("Odd era");
    // and they survive a second round trip
    expect(parseTimelineXml(out).unparsedEvents).toHaveLength(1);
  });

  it("survive regenerate, and their notes are not treated as orphans", async () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main", backupEnabled: false };
    const vault = new VaultAdapter(app as never);
    const ctx = {
      app: app as never, plugin: new Plugin(app) as never, vault,
      templates: new TemplateService(app as never, vault, () => settings),
      cache: new TimelineCache(app as never, () => settings),
      getSettings: () => settings, saveSettings: async () => {},
      withSelfWrite: async (fn: () => Promise<unknown>) => fn(),
      setDiagnostics: () => {}, getDiagnostics: () => [],
      createEventInteractive: vi.fn(async () => {}), appendSyncLog: async () => {},
    } as unknown as CommandsContext;
    app.vault.seed("t.timeline", X, 50);
    await importXml(ctx);
    // A note that used to belong to the event that is now unreadable in the XML.
    app.vault.seed("Events/broken.md", withContentHash(note("broken")));
    app.vault.seed("t.timeline", X, 60);
    await importXml(ctx);
    expect(app.vault.files.has("Events/broken.md")).toBe(true);
    await regenerateXml(ctx);
    const out = app.vault.text("t.timeline");
    expect(out).toContain("keep me");
    expect(out).toContain("Odd era");
  });

  it("copes with an unreadable node that has no id", () => {
    const doc = parseTimelineXml(`<timeline><events><event><start>x</start></event></events></timeline>`);
    expect(doc.unparsedEvents).toHaveLength(1);
  });
});

describe("sync leftovers", () => {
  const ev = (id: string, text = id) => `<event id="${id}"><start>0100-01-01</start><end>0200-01-01</end><text>${text}</text></event>`;
  const setup = () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main", backupEnabled: false };
    const vault = new VaultAdapter(app as never);
    const cache = new TimelineCache(app as never, () => settings);
    let diagnostics: string[] = [];
    const log: string[] = [];
    const ctx = {
      app: app as never, plugin: new Plugin(app) as never, vault,
      templates: new TemplateService(app as never, vault, () => settings),
      cache, getSettings: () => settings, saveSettings: async () => {},
      withSelfWrite: async (fn: () => Promise<unknown>) => fn(),
      setDiagnostics: (l: string[]) => { diagnostics = l; }, getDiagnostics: () => diagnostics,
      createEventInteractive: vi.fn(async () => {}), appendSyncLog: async (e: string) => { log.push(e); },
    } as unknown as CommandsContext;
    return { app, ctx, cache, settings, log, diagnostics: () => diagnostics };
  };

  it("keeps two ids that sanitise to the same file name apart", async () => {
    const { app, ctx } = setup();
    app.vault.seed("t.timeline", xml(ev("a/b", "Slash") + ev("a-b", "Dash") + ev("a:b", "Colon")), 50);
    await importXml(ctx);
    const texts = Object.fromEntries(
      ["Events/a-b.md", "Events/a-b-2.md", "Events/a-b-3.md"].map((p) => [p, parseEventNote(app.vault.text(p), { path: p }).note?.event.id])
    );
    expect(texts).toEqual({ "Events/a-b.md": "a/b", "Events/a-b-2.md": "a-b", "Events/a-b-3.md": "a:b" });
    // and a second import finds each where it went
    app.vault.seed("t.timeline", xml(ev("a/b", "Slash") + ev("a-b", "Dash") + ev("a:b", "Colon")), 60);
    await importXml(ctx);
    expect(app.vault.getFiles().filter((f) => f.path.startsWith("Events/a-b")).length).toBe(3);
  });

  it("does not overwrite a different event's note that already has the default name", async () => {
    const { app, ctx } = setup();
    app.vault.seed("Events/a-b.md", note("someone-else"));
    app.vault.seed("Events/plain-b.md", "not an event");
    app.vault.seed("t.timeline", xml(ev("a-b", "Mine") + ev("plain-b", "Plain")), 50);
    await importXml(ctx);
    expect(app.vault.text("Events/a-b.md")).toContain("someone-else");
    expect(app.vault.text("Events/a-b-2.md")).toContain("Mine");
    // a file that is not an event note stays the caller's problem: skipped, not overwritten
    expect(app.vault.text("Events/plain-b.md")).toBe("not an event");
  });

  it("flags a note edited here whose event also changed in the XML", async () => {
    const { app, ctx, log, diagnostics } = setup();
    app.vault.seed("t.timeline", xml(ev("a", "Alpha") + ev("b", "Beta")), 50);
    await importXml(ctx);
    for (const id of ["a", "b"]) app.vault.seed(`Events/${id}.md`, app.vault.text(`Events/${id}.md`) + "\nmy own words\n");
    app.vault.seed("t.timeline", xml(ev("a", "Alpha, changed in the XML") + ev("b", "Beta")), 60);
    Notice.reset();
    await importXml(ctx);
    // both were edited here; only a also changed in the XML
    expect(Notice.messages().pop()).toContain("2 skipped (local edits), 1 of them also changed in the XML");
    expect(diagnostics()).toEqual([expect.stringContaining("Events/a.md: edited here and changed in the XML")]);
    expect(log).toContain("import-conflict");
  });

  it("cannot call a conflict when the note does not say what it was copied from", async () => {
    const { app, ctx, log } = setup();
    app.vault.seed("t.timeline", xml(ev("a", "Alpha")), 50);
    await importXml(ctx);
    app.vault.seed("Events/a.md", app.vault.text("Events/a.md").replace(/^timeline_src: .*\n/m, "") + "\nedited\n");
    app.vault.seed("t.timeline", xml(ev("a", "Alpha, changed")), 60);
    await importXml(ctx);
    expect(log).not.toContain("import-conflict");
  });

  it("records the XML as it was before the import began", async () => {
    const { app, ctx, settings } = setup();
    app.vault.seed("t.timeline", xml(ev("a")), 50);
    const before = contentFingerprint(app.vault.text("t.timeline"));
    await importXml(ctx);
    expect(settings.lastSeenXmlFingerprint).toBe(before);
    app.vault.failNext.set("read", new Error("mid-sync"));
    await importXml(ctx);
    expect(settings.lastSeenXmlFingerprint).toBeNull();
  });

  it("finds an era note that was renamed, for import and for the inspector's lookup", async () => {
    const { app, ctx, settings } = setup();
    const X = `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version><categories/><events>${ev("a")}</events><eras><era><name>Old era</name><start>0001-01-01 00:00:00</start><end>0500-01-01 00:00:00</end></era></eras></timeline>`;
    app.vault.seed("t.timeline", X, 50);
    await importXml(ctx);
    expect(await findEraNotePath(ctx.vault, settings, "old-era")).toBe("Events/_eras/old-era.md");
    app.vault.seed("Events/_eras/The Old Era.md", app.vault.text("Events/_eras/old-era.md"));
    app.vault.remove("Events/_eras/old-era.md");
    expect(await findEraNotePath(ctx.vault, settings, "old-era")).toBe("Events/_eras/The Old Era.md");
    expect(await findEraNotePath(ctx.vault, settings, "nope")).toBeNull();
    app.vault.seed("Events/_eras/old-era.md", "garbage"); // default name taken by something unreadable as an era
    expect(await findEraNotePath(ctx.vault, settings, "old-era")).toBe("Events/_eras/The Old Era.md");
    app.vault.remove("Events/_eras/The Old Era.md");
    expect(await findEraNotePath(ctx.vault, settings, "old-era")).toBe("Events/_eras/old-era.md");
    // a read failure on one candidate does not hide the others
    app.vault.seed("Events/_eras/other.md", "x");
    app.vault.failNext.set("read", new Error("mid-sync"));
    expect(await findEraNotePath(ctx.vault, settings, "old-era")).toBe("Events/_eras/old-era.md");
    // import updates the renamed note in place instead of writing a twin
    app.vault.remove("Events/_eras/old-era.md");
    app.vault.remove("Events/_eras/other.md");
    app.vault.seed("Events/_eras/Renamed.md", withContentHash(renderEraMarkdown({ id: "old-era", name: "Old era", start: { year: 1 }, end: { year: 400 } }, "main", "t.timeline", 5)));
    app.vault.seed("t.timeline", X, 60);
    await importXml(ctx);
    expect(app.vault.files.has("Events/_eras/old-era.md")).toBe(false);
    expect(app.vault.text("Events/_eras/Renamed.md")).toContain("year: 500");
  });
});

describe("remaining branches of the sync leftovers", () => {
  it("writes a doc that has unreadable eras but no readable ones", () => {
    const era = parseTimelineXml(`<timeline><eras><era><name>x</name><start>?</start><end>0500-01-01</end></era></eras></timeline>`).unparsedEras;
    const out = writeTimelineXml({ categories: [], events: [], unparsedEras: era });
    expect(out).toContain("<eras>");
    expect(out).toContain("<name>x</name>");
  });

  it("fingerprints an event with links", () => {
    const base = { id: "a", text: " A ", start: { year: 1 }, end: { year: 2 }, isPoint: false };
    expect(eventSourceKey({ ...base, hyperlinks: [" http://x "] })).toContain("http://x");
    expect(eventSourceKey(base)).toContain('"hyperlinks":[]');
  });

  it("imports around an unreadable event that has no id, and truncates a long conflict list", async () => {
    const app = new FakeApp();
    const settings: TimelineXmlSyncSettings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", timelineId: "main", backupEnabled: false };
    const vault = new VaultAdapter(app as never);
    const logs: string[][] = [];
    const ctx = {
      app: app as never, plugin: new Plugin(app) as never, vault,
      templates: new TemplateService(app as never, vault, () => settings),
      cache: new TimelineCache(app as never, () => settings),
      getSettings: () => settings, saveSettings: async () => {},
      withSelfWrite: async (fn: () => Promise<unknown>) => fn(),
      setDiagnostics: () => {}, getDiagnostics: () => [],
      createEventInteractive: vi.fn(async () => {}), appendSyncLog: async (e: string, _p: string, d: string) => { logs.push([e, d]); },
    } as unknown as CommandsContext;
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
    const events = (suffix: string) => ids.map((id) => `<event id="${id}"><start>0100-01-01</start><end>0200-01-01</end><text>${id}${suffix}</text></event>`).join("") + `<event><start>nope</start></event>`;
    app.vault.seed("t.timeline", xml(events("")), 50);
    await importXml(ctx);
    for (const id of ids) app.vault.seed(`Events/${id}.md`, app.vault.text(`Events/${id}.md`) + "\nedited\n");
    app.vault.seed("t.timeline", xml(events(" changed")), 60);
    await importXml(ctx);
    expect(logs.find(([e]) => e === "import-conflict")?.[1]).toMatch(/…$/);
  });
});
