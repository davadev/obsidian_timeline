// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice, Plugin, Setting } from "../testUtils/obsidian";
import {
  autoDetectEventNotes,
  autoDetectXml,
  importXml,
  loadAllNotes,
  openDiagnostics,
  rebuildIndex,
  regenerateXml,
  registerCommands,
  validateNotes,
  wipeAndReimport,
  type CommandsContext,
} from "../src/obsidian/commands";
import { TimelineCache } from "../src/obsidian/cache";
import { TemplateService } from "../src/obsidian/template-service";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { DEFAULT_SETTINGS, EVENT_NOTE_SCHEMA_VERSION, type TimelineXmlSyncSettings } from "../src/settings";
import { setLogLevel } from "../src/logger";
import { parseTimelineXml } from "../src/timeline/xml-parser";
import { FakeApp } from "../testUtils/fake-app";

const ICON = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const XML = (extra = "", events = "") => `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version><timetype>gregoriantime</timetype>
<categories><category><name>War</name><color>200,10,10</color></category><category><name></name></category><category><name>Peace</name><color>1,2,3</color></category></categories>
<events>
<event id="a"><start>0100-01-01 00:00:00</start><end>0200-01-01 00:00:00</end><text>Alpha</text><category>War</category></event>
<event id="b"><start>0300-01-01 00:00:00</start><end>0300-01-01 00:00:00</end><text>Beta</text><category>Peace</category>${extra}</event>${events}
</events>
<eras><era><name>Old era</name><start>0001-01-01 00:00:00</start><end>0500-01-01 00:00:00</end></era></eras>
<view><displayed_period><start>0001-01-01 00:00:00</start><end>0900-01-01 00:00:00</end></displayed_period></view></timeline>`;

let app: FakeApp;
let settings: TimelineXmlSyncSettings;
let plugin: Plugin;
let ctx: CommandsContext;
let diagnostics: string[];
let saves: number;
let syncLog: Array<[string, string, string]>;
let selfWrites: Array<string[] | undefined>;

beforeEach(() => {
  Notice.reset();
  Modal.instances.length = 0;
  Setting.instances.length = 0;
  setLogLevel("error");
  app = new FakeApp();
  settings = { ...DEFAULT_SETTINGS, sourceXmlPath: "t.timeline", eventNotesDir: "Events", templatesDir: "Templates", timelineId: "main", backupRetention: 2 };
  diagnostics = [];
  saves = 0;
  syncLog = [];
  selfWrites = [];
  plugin = new Plugin(app);
  const vault = new VaultAdapter(app as never);
  const cache = new TimelineCache(app as never, () => settings);
  ctx = {
    app: app as never, plugin: plugin as never, vault,
    templates: new TemplateService(app as never, vault, () => settings),
    cache, getSettings: () => settings,
    saveSettings: async () => { saves++; },
    withSelfWrite: async (fn, paths) => { selfWrites.push(paths); return fn(); },
    setDiagnostics: (l) => { diagnostics = l; },
    getDiagnostics: () => diagnostics,
    createEventInteractive: vi.fn(async () => {}),
    appendSyncLog: async (e, p, d) => { syncLog.push([e, p, d]); },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

const setMtime = (path: string, mtime: number) => {
  (app.vault.files.get(path) as unknown as { stat: { mtime: number } }).stat.mtime = mtime;
};

const note = (id: string, over = "") =>
  `---\ntitle: ${id}\ntimeline:\n  enabled: true\n  event_id: ${id}\n  category: War\n  start: {year: 10}\n  end: {year: 20}\n${over}---\n# ${id}\n`;

describe("registration", () => {
  it("registers the commands, each wired to its action", async () => {
    registerCommands(ctx);
    expect(plugin.commands.map((c) => c.id)).toEqual([
      "txs-import", "txs-validate", "txs-regenerate", "txs-create-template", "txs-create-event",
      "txs-diagnostics", "txs-rebuild-index", "txs-wipe-reimport", "txs-auto-detect", "txs-auto-detect-xml",
    ]);
    const run = async (id: string) => plugin.commands.find((c) => c.id === id)!.callback!();
    await run("txs-create-event");
    expect(ctx.createEventInteractive).toHaveBeenCalled();
    await run("txs-create-template");
    expect(Notice.messages()).toContain("Template written: Templates/Timeline Event.md");
    await run("txs-diagnostics");
    await run("txs-rebuild-index");
    expect(Notice.messages()).toContain("Timeline index rebuilt.");
  });

  it("reports an action's failure as a notice instead of throwing", async () => {
    registerCommands(ctx);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    settings.sourceXmlPath = "";
    for (const id of ["txs-import", "txs-regenerate", "txs-wipe-reimport"]) await plugin.commands.find((c) => c.id === id)!.callback!();
    expect(Notice.messages().filter((m) => m.startsWith("Timeline XML Sync:"))).toHaveLength(3);
    settings.templatesDir = "";
    await plugin.commands.find((c) => c.id === "txs-create-template")!.callback!();
    ctx.createEventInteractive = vi.fn(async () => { throw new Error("modal failed"); });
    registerCommands(ctx);
    await plugin.commands.filter((c) => c.id === "txs-create-event")[1].callback!();
    expect(Notice.messages()).toContain("Timeline XML Sync: modal failed");
    expect(err).toHaveBeenCalled();
    await plugin.commands.find((c) => c.id === "txs-auto-detect")!.callback!();
    await plugin.commands.find((c) => c.id === "txs-auto-detect-xml")!.callback!();
    await plugin.commands.find((c) => c.id === "txs-validate")!.callback!();
  });
});

describe("importXml", () => {
  it("needs both paths configured", async () => {
    settings.sourceXmlPath = "";
    await expect(importXml(ctx)).rejects.toThrow("Configure XML path in settings first.");
    settings.sourceXmlPath = "t.timeline";
    settings.eventNotesDir = "";
    await expect(importXml(ctx)).rejects.toThrow("Configure event notes directory in settings first.");
  });

  it("writes event, era and metadata notes, ingests categories and records the XML baseline", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    expect(app.vault.files.has("Events/a.md")).toBe(true);
    expect(app.vault.files.has("Events/b.md")).toBe(true);
    expect(app.vault.files.has("Events/_eras/old-era.md")).toBe(true);
    expect(app.vault.text("Events/_timeline/timeline-metadata.md")).toContain("Old era");
    expect(settings.knownCategories).toEqual(["Peace", "War"]);
    expect(settings.categoryColors).toEqual({ War: "rgb(200,10,10)", Peace: "rgb(1,2,3)" });
    expect(settings.lastImportSchemaVersion).toBe(EVENT_NOTE_SCHEMA_VERSION);
    expect(settings.lastWrittenXmlMtime).toBe(50);
    expect(settings.lastSeenXmlFingerprint).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    expect(Notice.messages().pop()).toBe("Timeline import done — 2 created, 0 updated, 2 total, 1 era(s).");
  });

  it("keeps palette colours the user already chose, and a non r,g,b colour as-is", async () => {
    settings.categoryColors = { War: "#123456" };
    app.vault.seed("t.timeline", XML().replace("1,2,3", "teal"));
    await importXml(ctx);
    expect(settings.categoryColors).toEqual({ War: "#123456", Peace: "teal" });
  });

  it("skips notes whose files are newer than the XML they were written from", async () => {
    app.vault.clock = 100_000; // notes are written "long after" the XML's mtime stamp
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    Notice.reset();
    await importXml(ctx);
    expect(Notice.messages().pop()).toContain("0 created, 0 updated, 4 skipped");
    expect(syncLog[0][0]).toBe("import-skipped");
  });

  it("reports updates when stamps say the note is the plugin's own", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    for (const p of ["Events/a.md", "Events/b.md", "Events/_eras/old-era.md", "Events/_timeline/timeline-metadata.md"]) {
      setMtime(p, 40);
    }
    Notice.reset();
    await importXml(ctx);
    expect(Notice.messages().pop()).toContain("0 created, 2 updated, 2 total, 1 era(s).");
  });

  it("reports era skips in the summary", async () => {
    app.vault.clock = 100_000;
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    for (const p of ["Events/a.md", "Events/b.md", "Events/_timeline/timeline-metadata.md"]) setMtime(p, 40);
    Notice.reset();
    await importXml(ctx);
    expect(Notice.messages().pop()).toContain("1 skipped");
  });

  it("refuses to overwrite a note it cannot parse", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    app.vault.seed("Events/a.md", "x");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setLogLevel("warn");
    const read = vi.spyOn(VaultAdapter.prototype, "readText").mockImplementation(async function (this: VaultAdapter, p: string) {
      if (p === "Events/a.md" || p === "Events/_eras/old-era.md" || p === "Events/_timeline/timeline-metadata.md") throw new Error("unreadable");
      return app.vault.text(p);
    });
    app.vault.seed("Events/_eras/old-era.md", "x");
    app.vault.seed("Events/_timeline/timeline-metadata.md", "x");
    await importXml(ctx);
    expect(syncLog[0][2]).toContain("Events/a.md");
    expect(syncLog[0][2]).toContain("Events/_eras/old-era.md");
    expect(syncLog[0][2]).toContain("timeline-metadata.md");
    expect(Notice.messages().pop()).toContain("3 skipped");
    read.mockRestore();
  });

  it("truncates a long skipped list in the log", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `<event id="e${i}"><start>0100-01-01 00:00:00</start><end>0100-01-01 00:00:00</end><text>E${i}</text></event>`).join("");
    app.vault.clock = 100_000;
    app.vault.seed("t.timeline", XML("", many), 50);
    await importXml(ctx);
    await importXml(ctx);
    expect(syncLog[0][2]).toMatch(/…$/);
  });

  it("writes an event's embedded image to an attachment", async () => {
    app.vault.seed("t.timeline", XML(`<icon>${ICON}</icon>`), 50);
    await importXml(ctx);
    expect(app.vault.files.has("Events/_attachments/b.png")).toBe(true);
    expect(app.vault.text("Events/b.md")).toContain("icon_path: Events/_attachments/b.png");
  });

  it("carries on when an image cannot be written", async () => {
    app.vault.seed("t.timeline", XML(`<icon>${ICON}</icon>`), 50);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setLogLevel("warn");
    vi.spyOn(VaultAdapter.prototype, "writeBinary").mockRejectedValue(new Error("disk full"));
    await importXml(ctx);
    expect(app.vault.text("Events/b.md")).not.toContain("icon_path");
    expect(app.vault.files.has("Events/b.md")).toBe(true);
  });

  it("ignores a blank icon, and records no fingerprint when the XML cannot be re-read", async () => {
    app.vault.seed("t.timeline", XML("<icon>  </icon>"), 50);
    const real = VaultAdapter.prototype.readText;
    vi.spyOn(VaultAdapter.prototype, "readText").mockImplementation(async function (this: VaultAdapter, p: string) {
      if (p === "t.timeline") throw new Error("gone");
      return real.call(this, p);
    });
    await importXml(ctx);
    expect(settings.lastSeenXmlFingerprint).toBeNull();
  });

  it("copes with a parsed document that has no era list", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    const real = await ctx.cache.getXml("t.timeline");
    vi.spyOn(ctx.cache, "getXml").mockResolvedValue({ ...real, eras: undefined });
    await importXml(ctx);
    expect(app.vault.files.has("Events/_eras")).toBe(false);
  });

  it("works for an XML with no eras and no baseline mtime", async () => {
    app.vault.seed("t.timeline", XML().replace(/<eras>[\s\S]*<\/eras>/, ""), 50);
    vi.spyOn(VaultAdapter.prototype, "getMtime").mockReturnValue(null);
    settings.lastWrittenXmlMtime = 7;
    await importXml(ctx);
    expect(settings.lastWrittenXmlMtime).toBe(7);
    expect(Notice.messages().pop()).toBe("Timeline import done — 2 created, 0 updated, 2 total.");
  });
});

describe("validation and loading", () => {
  it("reads events, eras and the metadata note out of the notes folder", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    app.vault.seed("Events/bad.md", "---\ntimeline:\n  enabled: true\n  start: {year: x}\n---\n");
    const r = await loadAllNotes(ctx);
    expect(r.notes.map((n) => n.event.id).sort()).toEqual(["a", "b"]);
    expect(r.metaPatch?.eras?.map((e) => e.name)).toEqual(["Old era"]);
    expect(r.metaPatch?.categories?.length).toBeGreaterThan(0);
    expect(r.metaStamp).toBe(50);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("with eras but no metadata note, still returns the eras", async () => {
    app.vault.seed("Events/_eras/e.md", "---\ntimeline:\n  enabled: true\n  role: era\n  start: {year: 1}\n  end: {year: 2}\n---\n");
    const r = await loadAllNotes(ctx);
    expect(r.metaPatch?.eras).toHaveLength(1);
    expect(r.metaStamp).toBeUndefined();
  });

  it("validateNotes reports success or the issues found", async () => {
    app.vault.seed("Events/a.md", note("a"));
    await validateNotes(ctx);
    expect(Notice.messages().pop()).toBe("Timeline: all 1 event notes valid.");
    app.vault.seed("Events/dup.md", note("a"));
    await validateNotes(ctx);
    expect(Notice.messages().pop()).toContain("1 validation issue(s)");
    expect(diagnostics[0]).toContain("Duplicate");
  });
});

describe("regenerateXml", () => {
  const prime = async () => {
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    Notice.reset();
    syncLog.length = 0;
  };

  it("needs an XML path", async () => {
    settings.sourceXmlPath = "";
    await expect(regenerateXml(ctx)).rejects.toThrow("Configure XML path in settings first.");
  });

  it("writes the merged XML back, keeps a pruned backup, and records its own write", async () => {
    await prime();
    app.vault.seed("Events/a.md", app.vault.text("Events/a.md").replace("# Alpha", "# Alpha"));
    app.vault.seed("Events/new.md", note("new"));
    await regenerateXml(ctx);
    const out = parseTimelineXml(app.vault.text("t.timeline"));
    expect(out.events.map((e) => e.id).sort()).toEqual(["a", "b", "new"]);
    expect(app.vault.getFiles().filter((f) => f.path.startsWith("t.timeline.bak-"))).toHaveLength(1);
    expect(settings.lastSeenXmlFingerprint).toBeTruthy();
    expect(Notice.messages().pop()).toBe("Timeline XML regenerated — 3 events.");
    for (let i = 0; i < 3; i++) await regenerateXml(ctx);
    expect(app.vault.getFiles().filter((f) => f.path.startsWith("t.timeline.bak-")).length).toBeLessThanOrEqual(2);
  });

  it("creates the XML from scratch when it does not exist yet, without a backup", async () => {
    settings.sourceXmlPath = "fresh.timeline";
    app.vault.seed("Events/a.md", note("a"));
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("fresh.timeline")).events.map((e) => e.id)).toEqual(["a"]);
    expect(app.vault.getFiles().some((f) => f.path.includes(".bak-"))).toBe(false);
  });

  it("skips the backup when disabled, and the write stamp when the mtime is unreadable", async () => {
    await prime();
    settings.backupEnabled = false;
    vi.spyOn(VaultAdapter.prototype, "getMtime").mockReturnValue(null);
    const before = settings.lastWrittenXmlMtime;
    await regenerateXml(ctx);
    expect(app.vault.getFiles().some((f) => f.path.includes(".bak-"))).toBe(false);
    expect(settings.lastWrittenXmlMtime).toBe(before);
  });

  it("refuses to write while notes are invalid", async () => {
    await prime();
    app.vault.seed("Events/dup.md", note("a"));
    const before = app.vault.text("t.timeline");
    await regenerateXml(ctx);
    expect(Notice.messages().pop()).toContain("refusing to write XML");
    expect(app.vault.text("t.timeline")).toBe(before);
  });

  it("aborts when someone else changed the XML while merging", async () => {
    await prime();
    const real = VaultAdapter.prototype.getMtime;
    let calls = 0;
    vi.spyOn(VaultAdapter.prototype, "getMtime").mockImplementation(function (this: VaultAdapter, p: string) {
      const v = real.call(this, p);
      return p === "t.timeline" && ++calls > 1 ? (v as number) + 60_000 : v;
    });
    settings.lastWrittenXmlMtime = 1;
    await regenerateXml(ctx);
    expect(Notice.messages().pop()).toContain("changed externally");
    expect(syncLog[0][0]).toBe("regen-aborted-external-change");
  });

  it("embeds attachments as images, and warns when one cannot be read", async () => {
    await prime();
    app.vault.seed("Events/_attachments/b.png", Uint8Array.from(atob(ICON), (c) => c.charCodeAt(0)).buffer);
    app.vault.seed("Events/b.md", app.vault.text("Events/b.md").replace("category: Peace", "category: Peace\n  icon_path: Events/_attachments/b.png"));
    app.vault.seed("Events/a.md", app.vault.text("Events/a.md").replace("category: War", "category: War\n  icon_path: Events/_attachments/missing.png"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setLogLevel("warn");
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).events.find((e) => e.id === "b")?.icon).toBeTruthy();
  });

  it("applies the metadata note's categories, eras and view unless it is older than the XML", async () => {
    await prime();
    await regenerateXml(ctx);
    const out = parseTimelineXml(app.vault.text("t.timeline"));
    expect(out.eras?.map((e) => e.name)).toEqual(["Old era"]);
    expect(out.view?.displayedPeriod).toBeTruthy();
  });

  it("keeps the XML's own categories when the metadata note is stale", async () => {
    await prime();
    const meta = "Events/_timeline/timeline-metadata.md";
    app.vault.seed(meta, app.vault.text(meta).replace(/last_synced_xml_mtime: \d+/, "last_synced_xml_mtime: 1"));
    setMtime("t.timeline", 99_999);
    settings.lastWrittenXmlMtime = 99_999;
    await regenerateXml(ctx);
    expect(Notice.messages()).toContain("Timeline metadata note is older than the XML — keeping XML's categories/eras/view. Run \"import XML\" to refresh the metadata note.");
    expect(syncLog.map((l) => l[0])).toContain("meta-stale-skip");
  });

  it("with a stale metadata note and no era notes, leaves the eras to the XML", async () => {
    await prime();
    const meta = "Events/_timeline/timeline-metadata.md";
    app.vault.seed(meta, app.vault.text(meta).replace(/last_synced_xml_mtime: \d+/, "last_synced_xml_mtime: 1").replace(/eras:[\s\S]*?view:/, "eras: []\nview:"));
    app.vault.remove("Events/_eras/old-era.md");
    setMtime("t.timeline", 99_999);
    settings.lastWrittenXmlMtime = 99_999;
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).eras?.length).toBe(1);
  });

  it("handles a metadata note that lacks parts", async () => {
    await prime();
    const meta = "Events/_timeline/timeline-metadata.md";
    app.vault.seed(meta, "---\ntimeline:\n  enabled: true\n  role: metadata\n---\n");
    app.vault.remove("Events/_eras/old-era.md");
    await regenerateXml(ctx);
    expect(parseTimelineXml(app.vault.text("t.timeline")).version).toBe("2.11.0");
  });
});

describe("wipeAndReimport", () => {
  it("needs configuration and an existing XML", async () => {
    settings.sourceXmlPath = "";
    await expect(wipeAndReimport(ctx)).rejects.toThrow("Configure XML path and event notes directory first.");
    settings.sourceXmlPath = "t.timeline";
    await expect(wipeAndReimport(ctx)).rejects.toThrow("XML not found: t.timeline");
  });

  it("backs everything up, removes the old notes and imports afresh", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    app.vault.seed("Events/stray.md", note("stray"));
    Notice.reset();
    await wipeAndReimport(ctx);
    expect(app.vault.files.has("Events/stray.md")).toBe(false);
    expect(app.vault.files.has("Events/a.md")).toBe(true);
    expect([...app.vault.files.keys()].some((p) => p.startsWith("Events/_backups/wipe-"))).toBe(true);
    expect(syncLog[0][0]).toBe("wipe-backup");
    expect(Notice.messages()).toEqual(expect.arrayContaining(["Starting wipe + reimport…", expect.stringMatching(/^Backed up MD notes to/), expect.stringMatching(/^Reimport complete — removed \d+ old notes\.$/)]));
    expect(settings.lastImportSchemaVersion).toBe(EVENT_NOTE_SCHEMA_VERSION);
  });

  it("prunes old backups beyond the retention", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    await importXml(ctx);
    for (let i = 0; i < 4; i++) {
      await wipeAndReimport(ctx);
      await new Promise((r) => setTimeout(r, 3));
    }
    const folders = [...app.vault.files.keys()].filter((p) => /^Events\/_backups\/wipe-[^/]+$/.test(p));
    expect(folders.length).toBeLessThanOrEqual(2);
  });

  it("works with backups disabled and nothing to back up", async () => {
    settings.backupEnabled = false;
    app.vault.seed("t.timeline", XML(), 50);
    await wipeAndReimport(ctx);
    expect(app.vault.getFiles().some((f) => f.path.includes(".bak-"))).toBe(false);
    expect(syncLog).toEqual([]);
  });

  it("copes with an XML backup that cannot be made", async () => {
    app.vault.seed("t.timeline", XML(), 50);
    vi.spyOn(VaultAdapter.prototype, "backup").mockResolvedValue(null);
    await wipeAndReimport(ctx);
    expect(app.vault.files.has("Events/a.md")).toBe(true);
  });
});

describe("auto-detect", () => {
  it("auto-detect XML: none, one, or a choice among several", async () => {
    expect(await autoDetectXml(ctx)).toBeNull();
    expect(Notice.messages().pop()).toContain("No .timeline file found");
    app.vault.seed("one.timeline", "");
    expect(await autoDetectXml(ctx)).toBe("one.timeline");
    expect(settings.sourceXmlPath).toBe("one.timeline");
    expect(saves).toBe(1);
    app.vault.seed("two.timeline", "");
    const picked = autoDetectXml(ctx);
    await vi.waitFor(() => expect(Modal.instances.length).toBe(1));
    expect(Setting.instances.map((s) => s.name)).toEqual(["one.timeline", "two.timeline"]);
    await Setting.instances[1].buttons[0].click();
    expect(await picked).toBe("two.timeline");
    expect(settings.sourceXmlPath).toBe("two.timeline");
    expect(Notice.messages().pop()).toBe("Using XML: two.timeline");
  });

  it("auto-detect XML: dismissing the chooser changes nothing", async () => {
    app.vault.seed("one.timeline", "");
    app.vault.seed("two.timeline", "");
    settings.sourceXmlPath = "keep";
    const picked = autoDetectXml(ctx);
    await vi.waitFor(() => expect(Modal.instances.length).toBe(1));
    Modal.instances[0].close();
    expect(await picked).toBeNull();
    expect(settings.sourceXmlPath).toBe("keep");
  });

  it("auto-detect notes: finds the folder and the most common timeline id", async () => {
    expect((await autoDetectEventNotes(ctx), Notice.messages().pop())).toBe("No timeline-enabled notes found in vault.");
    const add = (path: string, fm: Record<string, unknown> | undefined) => {
      app.vault.seed(path, "");
      app.index(path, fm);
    };
    add("Hist/Rome/a.md", { timeline: { enabled: true, id: "rome" } });
    add("Hist/Rome/b.md", { timeline: { enabled: true, id: "rome" } });
    add("Hist/Rome/sub/c.md", { timeline: { enabled: true, id: "greece" } });
    add("Hist/Rome/d.md", { timeline: { enabled: true, id: 7 } });
    add("Hist/Rome/off.md", { timeline: { enabled: false } });
    add("Hist/Rome/arr.md", { timeline: [1] });
    add("Hist/Rome/str.md", { timeline: "x" });
    add("Hist/Rome/none.md", undefined);
    await autoDetectEventNotes(ctx);
    expect(settings.eventNotesDir).toBe("Hist/Rome");
    expect(settings.timelineId).toBe("rome");
    expect(Notice.messages().pop()).toBe('Detected 4 timeline note(s) in "Hist/Rome" (id: rome).');
  });

  it("auto-detect notes: keeps the current folder when the notes share none, and the id when none is set", async () => {
    const add = (path: string) => {
      app.vault.seed(path, "");
      app.index(path, { timeline: { enabled: true } });
    };
    add("A/x.md");
    add("B/y.md");
    settings.eventNotesDir = "Keep";
    settings.timelineId = "keepid";
    await autoDetectEventNotes(ctx);
    expect(settings.eventNotesDir).toBe("Keep");
    expect(settings.timelineId).toBe("keepid");
  });
});

describe("diagnostics and index", () => {
  it("prints what validation stored", async () => {
    const dump = vi.spyOn(console, "debug").mockImplementation(() => {});
    diagnostics = ["a: broken"];
    openDiagnostics(ctx);
    expect(dump).toHaveBeenCalledWith("[Timeline XML Sync]", "diagnostics:", ["a: broken"]);
    expect(Notice.messages()).toEqual(["Timeline diagnostics printed to the developer console (verbose)."]);
  });

  it("rebuilding re-validates", async () => {
    await rebuildIndex(ctx);
    expect(Notice.messages()).toEqual(["Timeline: all 0 event notes valid.", "Timeline index rebuilt."]);
  });
});
