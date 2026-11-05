// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, Modal, Notice, Platform, Setting, SuggestModal, TFile, WorkspaceLeaf } from "../testUtils/obsidian";
import TimelineXmlSyncPlugin from "../src/main";
import { InspectorView, VIEW_TYPE_INSPECTOR } from "../src/obsidian/inspector-view";
import { TimelineView, VIEW_TYPE_TIMELINE } from "../src/obsidian/timeline-view";
import { DEFAULT_SETTINGS, EVENT_NOTE_SCHEMA_VERSION } from "../src/settings";
import { setLogLevel } from "../src/logger";
import { initDeviceStore } from "../src/obsidian/app-storage";
import { FakeApp } from "../testUtils/fake-app";

const XML = `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version><categories/><events>
<event id="a"><start>0100-01-01 00:00:00</start><end>0200-01-01 00:00:00</end><text>Alpha</text></event></events></timeline>`;
const note = (id: string) => `---\ntimeline:\n  enabled: true\n  event_id: ${id}\n  start: {year: 10}\n  end: {year: 20}\n---\n# ${id}\n`;

let app: FakeApp;
let plugin: TimelineXmlSyncPlugin;
let priv: {
  safety: { crashDisabled: boolean; lastError?: string };
  runtimeCrashes: number;
  debouncedSync?: () => void;
  loadedAt: number;
  cache: { resolvePath(id: string): string | null; updateFile: (p: string) => void };
  commandsCtx: { createEventInteractive(): Promise<void>; getDiagnostics(): string[]; setDiagnostics(l: string[]): void; saveSettings(): Promise<void>; withSelfWrite<T>(fn: () => Promise<T>, p?: string[]): Promise<T> };
  vault: { exists(p: string): boolean };
  checkExternalXml(): Promise<void>;
  isSelfWrite(p: string): boolean;
  externalChangeAnnounced: boolean;
  recentSelfWrites: Map<string, number>;
  onVaultEvent(kind: string, f: unknown, old?: string): void;
  tripSafetyNet(e: Error, phase: string): Promise<void>;
  persistAll(): Promise<void>;
  guarded<A extends unknown[], R>(fn: (...a: A) => R, phase: string): (...a: A) => Promise<R | undefined>;
  runFirstInstall(): Promise<void>;
  installSafeMode(): void;
  rebuildDebouncedSync(): void;
};

const create = (stored?: unknown) => {
  plugin = new TimelineXmlSyncPlugin(app as never, { id: "timeline-xml-sync" } as never);
  (plugin as unknown as { data: unknown }).data = stored ?? null;
  priv = plugin as unknown as typeof priv;
  return plugin;
};
const raw = () => plugin as unknown as {
  commands: Array<{ id: string; name: string; callback: () => unknown }>;
  views: Map<string, (leaf: WorkspaceLeaf) => unknown>;
  ribbons: Array<{ icon: string; title: string; cb: () => void }>;
  events: Array<{ name: string; fn: (...a: unknown[]) => void }>;
  intervals: number[];
  settingTabs: unknown[];
  codeBlockProcessors: Map<string, (...a: unknown[]) => Promise<unknown>>;
  data: Record<string, unknown>;
};
const cmd = (id: string) => raw().commands.find((c) => c.id === id)!;
const fire = (name: string, ...args: unknown[]) => app.vault.emit(name, ...args);
const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  Notice.reset();
  Modal.instances.length = 0;
  Setting.instances.length = 0;
  Platform.isMobile = false;
  setLogLevel("error");
  initDeviceStore(new FakeApp() as never);
  app = new FakeApp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const processorCtx: Array<Record<string, (...a: unknown[]) => unknown>> = [];
vi.mock("../src/obsidian/markdown-postprocessor", async (orig) => ({
  ...(await orig<typeof import("../src/obsidian/markdown-postprocessor")>()),
  makeTimelineProcessor: (ctx: Record<string, (...a: unknown[]) => unknown>) => {
    processorCtx.push(ctx);
    return async (_src: string, el: HTMLElement | null) => {
      if (!el) throw new Error("no element");
    };
  },
}));

describe("onload", () => {
  it("registers the commands, views, ribbon icons, events, interval, settings tab and code-block processor", async () => {
    create();
    await plugin.onload();
    const r = raw();
    expect(r.commands.map((c) => c.id)).toEqual(expect.arrayContaining([
      "txs-import", "txs-regenerate", "txs-validate", "txs-create-era", "txs-insert-block", "txs-open-view", "txs-open-inspector", "txs-export-with-image",
    ]));
    expect([...r.views.keys()]).toEqual([VIEW_TYPE_TIMELINE, VIEW_TYPE_INSPECTOR]);
    expect(r.ribbons.map((x) => x.icon)).toEqual(["calendar-range", "plus-circle"]);
    expect(r.events).toHaveLength(6);
    expect(r.intervals).toHaveLength(1);
    expect(r.settingTabs).toHaveLength(1);
    expect([...r.codeBlockProcessors.keys()]).toEqual(["timeline"]);
    expect(r.views.get(VIEW_TYPE_TIMELINE)!(new WorkspaceLeaf())).toBeInstanceOf(TimelineView);
    expect(r.views.get(VIEW_TYPE_INSPECTOR)!(new WorkspaceLeaf())).toBeInstanceOf(InspectorView);
  });

  it("loads stored settings over the defaults, and the log level with them", async () => {
    create({ sourceXmlPath: "x.timeline", mirrorNames: { start: "begin" }, renderDefaults: { zoom: 9 }, knownCategories: "bad", logLevel: "debug", categoryColors: { A: "red" } });
    await plugin.loadSettings();
    expect(plugin.settings).toMatchObject({ sourceXmlPath: "x.timeline", knownCategories: [], logLevel: "debug", categoryColors: { A: "red" } });
    expect(plugin.settings.mirrorNames).toMatchObject({ start: "begin", end: "timeline_end" });
    expect(plugin.settings.renderDefaults.zoom).toBe(9);
    expect(plugin.settings.renderDefaults.mode).toBe(DEFAULT_SETTINGS.renderDefaults.mode);
    create("not an object");
    await plugin.loadSettings();
    expect(plugin.settings.sourceXmlPath).toBe(DEFAULT_SETTINGS.sourceXmlPath);
    create({ knownCategories: ["Z"] });
    await plugin.loadSettings();
    expect(plugin.settings.knownCategories).toEqual(["Z"]);
  });

  it("stays in safe mode after a crash, offering only the re-enable command", async () => {
    create({ __safety: { crashDisabled: true, lastError: "[onload] boom" } });
    await plugin.onload();
    expect(raw().commands.map((c) => c.id)).toEqual(["txs-reenable"]);
    expect(Notice.messages()).toEqual(["Timeline XML Sync auto-disabled after a crash: [onload] boom"]);
    await cmd("txs-reenable").callback();
    expect(raw().data.__safety).toEqual({ crashDisabled: false });
    expect(Notice.messages().pop()).toBe("Crash flag cleared. Reload Obsidian to re-enable.");
    create({ __safety: { crashDisabled: true } });
    await plugin.onload();
    expect(Notice.messages().pop()).toBe("Timeline XML Sync auto-disabled after a crash.");
  });

  it("trips the safety net when loading throws, and falls back to safe mode", async () => {
    vi.spyOn(app.vault, "on").mockImplementation(() => {
      throw new Error("vault exploded");
    });
    create();
    await plugin.onload();
    expect(priv.safety.crashDisabled).toBe(true);
    expect((raw().data.__safety as { lastError: string }).lastError).toBe("[onload] vault exploded");
    expect(raw().commands.map((c) => c.id)).toContain("txs-reenable");
  });

  it("survives the crash flag failing to save", async () => {
    create();
    vi.spyOn(plugin, "saveData").mockRejectedValue(new Error("disk"));
    await priv.tripSafetyNet(new Error("x"), "phase");
    expect(priv.safety.crashDisabled).toBe(true);
    await priv.tripSafetyNet({} as Error, "phase");
    expect(priv.safety.lastError).toBe("[phase] [object Object]");
  });

  it("turns auto-sync off by default on mobile, once", async () => {
    Platform.isMobile = true;
    create();
    await plugin.onload();
    expect(Notice.messages()[0]).toContain("auto-sync turned off on this device by default");
    Notice.reset();
    create();
    await plugin.onload();
    expect(Notice.messages().filter((m) => m.includes("auto-sync turned off"))).toHaveLength(0);
  });

  it("announces a schema change since the notes were last written", async () => {
    create({ lastImportSchemaVersion: EVENT_NOTE_SCHEMA_VERSION - 1 });
    await plugin.onload();
    expect(Notice.messages().pop()).toContain(`schema changed (v${EVENT_NOTE_SCHEMA_VERSION - 1} → v${EVENT_NOTE_SCHEMA_VERSION})`);
    Notice.reset();
    create({ lastImportSchemaVersion: EVENT_NOTE_SCHEMA_VERSION, firstRunCompleted: true });
    await plugin.onload();
    expect(Notice.messages()).toEqual([]);
  });
});

describe("first install", () => {
  it("auto-detects after a short delay, then remembers it ran", async () => {
    app.vault.seed("only.timeline", XML);
    create();
    await plugin.onload();
    expect(plugin.settings.firstRunCompleted).toBe(false);
    await settle(800);
    await vi.waitFor(() => expect(plugin.settings.firstRunCompleted).toBe(true));
    expect(plugin.settings.sourceXmlPath).toBe("only.timeline");
    expect(raw().data.firstRunCompleted).toBe(true);
  });

  it("still marks itself done when detection fails", async () => {
    create();
    await plugin.onload();
    vi.spyOn(app.vault, "getFiles").mockImplementation(() => {
      throw new Error("scan failed");
    });
    await priv.runFirstInstall();
    expect(plugin.settings.firstRunCompleted).toBe(true);
  });
});

describe("opening things", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true });
    await plugin.onload();
  });

  it("opens the timeline view in a new tab, or reveals the one that exists", async () => {
    await plugin.activateTimelineView();
    expect(app.mainLeaf.viewState).toEqual({ type: VIEW_TYPE_TIMELINE, active: true });
    expect(app.revealed).toEqual([app.mainLeaf]);
    const existing = new WorkspaceLeaf();
    app.leavesByType.set(VIEW_TYPE_TIMELINE, [existing]);
    await plugin.activateTimelineView();
    expect(app.revealed.pop()).toBe(existing);
    raw().ribbons[0].cb();
    await cmd("txs-open-view").callback();
  });

  it("opens the inspector in the right sidebar, reusing it, and loads an event", async () => {
    expect(await plugin.activateInspector()).toBeNull(); // the new leaf has no inspector view yet
    expect(app.rightLeaf!.viewState).toEqual({ type: VIEW_TYPE_INSPECTOR, active: true });
    const view = Object.create(InspectorView.prototype) as InspectorView;
    view.loadEvent = vi.fn(async () => {});
    const leaf = Object.assign(new WorkspaceLeaf(), { view });
    app.leavesByType.set(VIEW_TYPE_INSPECTOR, [leaf]);
    expect(await plugin.activateInspector("e1")).toBe(view);
    expect(view.loadEvent).toHaveBeenCalledWith("e1");
    expect(await plugin.activateInspector()).toBe(view);
    await cmd("txs-open-inspector").callback();
    app.leavesByType.clear();
    app.rightLeaf = null;
    expect(await plugin.activateInspector("e1")).toBeNull();
  });

  it("refreshes only the real timeline views", () => {
    const view = Object.create(TimelineView.prototype) as TimelineView;
    view.refreshFromCache = vi.fn(async () => {});
    app.leavesByType.set(VIEW_TYPE_TIMELINE, [Object.assign(new WorkspaceLeaf(), { view }), Object.assign(new WorkspaceLeaf(), { view: {} })]);
    plugin.refreshTimelineViews();
    expect(view.refreshFromCache).toHaveBeenCalledTimes(1);
  });

  describe("click routing", () => {
    const withInspector = () => {
      const view = Object.create(InspectorView.prototype) as InspectorView;
      view.loadEvent = vi.fn(async () => {});
      view.loadEra = vi.fn(async () => {});
      app.leavesByType.set(VIEW_TYPE_INSPECTOR, [Object.assign(new WorkspaceLeaf(), { view })]);
      return view;
    };

    it("opens the inspector for an event by default", async () => {
      const view = withInspector();
      plugin.onEventClick("e1");
      await vi.waitFor(() => expect(view.loadEvent).toHaveBeenCalledWith("e1"));
      expect(app.openedLinks).toHaveLength(0);
    });

    it("falls back to the note when the inspector cannot open", async () => {
      app.rightLeaf = null;
      app.vault.seed("Timeline events/e1.md", note("e1"));
      app.index("Timeline events/e1.md", { timeline_event_id: "e1" });
      vi.setSystemTime(Date.now() + 5000); // past the index rebuild cooldown
      plugin.onEventClick("e1");
      await vi.waitFor(() => expect(app.openedLinks).toHaveLength(1));
      expect(app.openedLinks[0].link).toBe("Timeline events/e1.md");
      plugin.onEventClick("unknown");
      await settle(5);
      expect(app.openedLinks).toHaveLength(1);
    });

    it("honours 'open note', and tolerates an id with no note", () => {
      plugin.settings.clickBehavior = "open-note";
      app.vault.seed("Timeline events/e1.md", note("e1"));
      app.index("Timeline events/e1.md", { timeline_event_id: "e1" });
      vi.setSystemTime(Date.now() + 5000);
      plugin.onEventClick("e1");
      plugin.onEventClick("missing");
      expect(app.openedLinks.map((l) => l.link)).toEqual(["Timeline events/e1.md"]);
    });

    it("routes an era to the inspector, else its note, else nothing", async () => {
      const view = withInspector();
      plugin.onEraClick("r1");
      await vi.waitFor(() => expect(view.loadEra).toHaveBeenCalledWith("r1"));
      app.leavesByType.clear();
      app.rightLeaf = null;
      app.vault.seed("Timeline events/_eras/r1.md", "x");
      plugin.onEraClick("r1");
      await vi.waitFor(() => expect(app.openedLinks).toHaveLength(1));
      plugin.onEraClick("none");
      await settle(5);
      expect(app.openedLinks).toHaveLength(1);
      plugin.settings.clickBehavior = "open-note";
      plugin.onEraClick("r1");
      plugin.onEraClick("none");
      expect(app.openedLinks).toHaveLength(2);
    });
  });
});

describe("creating things", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true });
    await plugin.onload();
  });

  it("the new-event command prompts, creates the note and opens it and the inspector", async () => {
    const view = Object.create(InspectorView.prototype) as InspectorView;
    view.loadEvent = vi.fn(async () => {});
    app.leavesByType.set(VIEW_TYPE_INSPECTOR, [Object.assign(new WorkspaceLeaf(), { view })]);
    const done = priv.commandsCtx.createEventInteractive();
    await vi.waitFor(() => expect(Setting.instances.length).toBe(1));
    await Setting.instances[0].text[0].type("Fresh");
    [...Modal.instances[0].contentEl.querySelectorAll("button")].find((b) => b.textContent === "Create")!.click();
    await settle(250);
    await done;
    expect(app.openedLinks[0].link).toBe("Timeline events/fresh.md");
    expect(view.loadEvent).toHaveBeenCalled();
  });

  it("the new-era command creates the era and opens it in the inspector", async () => {
    const view = Object.create(InspectorView.prototype) as InspectorView;
    view.loadEra = vi.fn(async () => {});
    app.leavesByType.set(VIEW_TYPE_INSPECTOR, [Object.assign(new WorkspaceLeaf(), { view })]);
    const done = plugin.createEraInteractive();
    await vi.waitFor(() => expect(Modal.instances.length).toBe(1));
    await Setting.instances[0].text[0].type("Age");
    const inputs = [...Modal.instances[0].contentEl.querySelectorAll("input")];
    const set = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event("input")); };
    set(inputs[0], "1");
    set(inputs[3], "2");
    [...Modal.instances[0].contentEl.querySelectorAll("button")].find((b) => b.textContent === "Create")!.click();
    await settle(250);
    await done;
    expect(view.loadEra).toHaveBeenCalled();
  });

  it("the new-era flow still works without an inspector view", async () => {
    const templates = (plugin as unknown as { templates: { createNewEraInteractive(v: unknown, cb: (id: string) => Promise<void>): Promise<void> } }).templates;
    vi.spyOn(templates, "createNewEraInteractive").mockImplementation(async (_v, cb) => cb("era-1"));
    app.rightLeaf = new WorkspaceLeaf(); // opens, but never becomes an inspector view
    const done = plugin.createEraInteractive();
    await settle(250);
    await done;
    expect(Notice.messages()).toEqual([]);
  });

  it("reports a failure to create an era", async () => {
    const templates = (plugin as unknown as { templates: { createNewEraInteractive(): Promise<void> } }).templates;
    vi.spyOn(templates, "createNewEraInteractive").mockRejectedValue(new Error("no folder"));
    await plugin.createEraInteractive();
    expect(Notice.messages()).toEqual(["Era create failed: no folder"]);
  });
});

describe("action picker and block insertion", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true });
    await plugin.onload();
  });

  it("offers the three actions, filtered by what is typed, and runs the chosen one", () => {
    const opened: Array<SuggestModal<{ label: string; description: string; run: () => void }>> = [];
    vi.spyOn(SuggestModal.prototype, "open").mockImplementation(function (this: SuggestModal<never>) {
      opened.push(this as never);
    });
    plugin.openTimelineActionPicker();
    type Action = { label: string; description: string; run: () => void };
    const picker = opened[0];
    const suggest = (q: string) => picker.getSuggestions(q) as Action[];
    expect(picker.placeholder).toBe("Pick a timeline action…");
    expect(suggest("").map((a) => a.label)).toEqual(["New timeline event", "New era", "Insert timeline view block"]);
    expect(suggest("ERA").map((a) => a.label)).toEqual(["New era"]);
    expect(suggest("cursor").map((a) => a.label)).toEqual(["Insert timeline view block"]);
    expect(suggest("zzz")).toEqual([]);
    const el = document.createElement("div");
    picker.renderSuggestion({ label: "L", description: "D", run() {} }, el);
    expect(el.querySelector(".txs-picker-title")?.textContent).toBe("L");
    expect(el.querySelector(".txs-picker-desc")?.textContent).toBe("D");
    const run = vi.fn();
    picker.onChooseSuggestion({ label: "", description: "", run }, new MouseEvent("click"));
    expect(run).toHaveBeenCalled();
    const spy = vi.spyOn(priv.commandsCtx, "createEventInteractive").mockResolvedValue();
    suggest("")[0].run();
    expect(spy).toHaveBeenCalled();
    app.activeView = null;
    suggest("")[2].run();
    expect(Notice.messages()).toContain("Open a note first.");
  });

  it("reports a picker that fails to open", () => {
    vi.spyOn(SuggestModal.prototype, "open").mockImplementation(() => {
      throw new Error("no modal");
    });
    plugin.openTimelineActionPicker();
    expect(Notice.messages()).toEqual(["Timeline picker failed: no modal"]);
    raw().ribbons[1].cb();
  });

  it("starts the era flow from the picker", () => {
    const opened: Array<SuggestModal<{ label: string; description: string; run: () => void }>> = [];
    vi.spyOn(SuggestModal.prototype, "open").mockImplementation(function (this: SuggestModal<never>) {
      opened.push(this as never);
    });
    plugin.openTimelineActionPicker();
    const spy = vi.spyOn(plugin, "createEraInteractive").mockResolvedValue();
    (opened[0].getSuggestions("") as { run: () => void }[])[1].run();
    expect(spy).toHaveBeenCalled();
  });

  it("inserts a ready-made block at the cursor", () => {
    const view = new MarkdownView(new WorkspaceLeaf() as never);
    const replaceSelection = vi.fn();
    Object.assign(view, { editor: { replaceSelection } });
    app.activeView = view;
    plugin.insertTimelineBlock();
    expect(replaceSelection).toHaveBeenCalledWith("```timeline\nmode: hybrid\nsource: main\n```\n");
    cmd("txs-insert-block").callback();
    expect(replaceSelection).toHaveBeenCalledTimes(2);
    app.activeView = null;
    plugin.insertTimelineBlock();
    expect(Notice.messages()).toEqual(["Open a note first."]);
  });

  it("exports the active note through the lazily-loaded exporter, handing it working hooks", async () => {
    app.activeFile = null;
    await cmd("txs-export-with-image").callback();
    expect(Notice.messages()).toEqual(["No active note."]);
    const doc = { categories: [], events: [{ id: "a", text: "A", start: { year: 1 }, end: { year: 2 }, isPoint: false }] };
    vi.spyOn((plugin as unknown as { cache: { getRenderDoc(): Promise<unknown> } }).cache, "getRenderDoc").mockResolvedValue(doc);
    app.activeFile = app.vault.seed("Note.md", "```timeline\nmode: bar\n```");
    vi.stubGlobal("createEl", (tag: string) => (tag === "canvas" ? { getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb: (b: unknown) => void) => cb({ arrayBuffer: async () => new ArrayBuffer(1) }) } : document.createElement(tag)));
    vi.stubGlobal("Image", class { onload: () => void = () => {}; set src(_: string) { queueMicrotask(() => this.onload()); } });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    await cmd("txs-export-with-image").callback();
    expect(app.vault.files.has("Note-exported.md")).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("vault events and auto-sync", () => {
  let regen: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    create({ firstRunCompleted: true, autoSyncDebounceMs: 100, autoSyncStartupDelayMs: 1000, sourceXmlPath: "t.timeline", eventNotesDir: "Events" });
    await plugin.onload();
    regen = vi.fn();
    priv.debouncedSync = regen;
    priv.loadedAt = Date.now() - 5000;
    app.vault.seed("Events/a.md", note("a"));
  });
  const file = (path: string) => app.vault.files.get(path)!;
  const emit = (kind: "create" | "modify" | "delete" | "rename", path: string, old?: string) => fire(kind, file(path) ?? Object.assign(new TFile(), { path, extension: path.split(".").pop() }), old);

  it("triggers auto-sync for a note change inside the notes folder", () => {
    emit("modify", "Events/a.md");
    emit("create", "Events/a.md");
    expect(regen).toHaveBeenCalledTimes(2);
  });

  it("keeps the index current and still syncs for a rename into the folder", () => {
    const spy = vi.spyOn(priv.cache, "updateFile");
    app.vault.seed("Elsewhere/b.md", note("b"));
    fire("rename", file("Elsewhere/b.md"), "Events/old.md"); // moved out of the folder
    expect(regen).toHaveBeenCalledTimes(1);
    fire("rename", file("Events/a.md"), "Elsewhere/old.md"); // moved in
    expect(spy).toHaveBeenCalled();
    fire("rename", file("Events/a.md")); // no old path: treated as a plain update
    fire("delete", file("Events/a.md"));
    expect(regen).toHaveBeenCalledTimes(4);
  });

  it("ignores folders, other file types, other folders, self-writes, disabled auto-sync and the startup grace period", () => {
    app.vault.mkdirs("Events/sub");
    fire("modify", file("Events/sub"));
    app.vault.seed("Events/pic.png");
    fire("modify", file("Events/pic.png"));
    app.vault.seed("Elsewhere/c.md");
    fire("modify", file("Elsewhere/c.md"));
    expect(regen).not.toHaveBeenCalled();

    plugin.settings.autoSync = false;
    fire("modify", file("Events/a.md"));
    expect(regen).not.toHaveBeenCalled();
    plugin.settings.autoSync = true;

    priv.loadedAt = Date.now();
    fire("modify", file("Events/a.md"));
    expect(regen).not.toHaveBeenCalled();
    priv.loadedAt = Date.now() - 5000;

    void plugin.withSelfWrite(async () => {}, ["Events/a.md"]);
    fire("modify", file("Events/a.md"));
    expect(regen).not.toHaveBeenCalled();
  });

  it("scopes self-write suppression: path stamps, the coarse sentinel, expiry and clean-up", async () => {
    await plugin.withSelfWrite(async () => {}, ["Events/a.md"]);
    expect(priv.isSelfWrite("Events/a.md")).toBe(true);
    expect(priv.isSelfWrite("Events/other.md")).toBe(true); // the sentinel covers legacy callers
    vi.setSystemTime(Date.now() + 6000);
    expect(priv.isSelfWrite("Events/a.md")).toBe(false);
    await plugin.withSelfWrite(async () => {});
    await settle(6000);
    expect(priv.recentSelfWrites.size).toBe(0);
    plugin.settings.selfWriteTtlMs = undefined as never;
    await plugin.withSelfWrite(async () => {});
    expect(priv.isSelfWrite("x")).toBe(true);
    await expect(plugin.withSelfWrite(async () => { throw new Error("inner"); })).rejects.toThrow("inner");
  });

  it("debounces the real auto-sync, and reports a failing sync", async () => {
    priv.rebuildDebouncedSync();
    const regenerate = vi.spyOn(app.vault, "process"); // unused; the XML is absent so the sync just writes
    void regenerate;
    app.vault.seed("t.timeline", "<not xml");
    priv.loadedAt = Date.now() - 5000;
    fire("modify", file("Events/a.md"));
    fire("modify", file("Events/a.md"));
    await settle(100);
    await vi.waitFor(() => expect(Notice.messages().some((m) => m.startsWith("Timeline auto-sync error:"))).toBe(true));
  });

  it("counts a failing handler as a crash and gives up after three", async () => {
    vi.spyOn(priv.cache, "updateFile").mockImplementation(() => {
      throw new Error("index broke");
    });
    for (let i = 0; i < 3; i++) fire("modify", file("Events/a.md"));
    await settle();
    expect(priv.runtimeCrashes).toBe(3);
    expect(priv.safety.crashDisabled).toBe(true);
  });

  it("coalesces metadata changes, and drops the index when the metadata cache has caught up", () => {
    const spy = vi.spyOn(priv.cache, "updateFile");
    for (const l of app.metaListeners.get("changed")!) {
      l({ path: "Events/a.md" });
      l({ path: "Events/b.md" });
      l({ path: "Events/a.md" });
    }
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["Events/a.md", "Events/b.md"]);
    for (const l of app.metaListeners.get("resolved")!) l();
    app.vault.seed("Events/late.md", note("late"));
    app.index("Events/late.md", { timeline_event_id: "late" });
    expect(priv.cache.resolvePath("late")).toBe("Events/late.md");
  });
});

describe("external XML changes", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true, sourceXmlPath: "t.timeline", lastWrittenXmlMtime: 1000, lastSeenXmlFingerprint: null });
    await plugin.onload();
  });

  it("does nothing without a path, a file, or a moved mtime", async () => {
    plugin.settings.sourceXmlPath = "";
    await priv.checkExternalXml();
    plugin.settings.sourceXmlPath = "t.timeline";
    await priv.checkExternalXml();
    app.vault.seed("t.timeline", XML, 1500);
    await priv.checkExternalXml();
    expect(Notice.messages()).toEqual([]);
  });

  it("says once when the file really changed, and logs it", async () => {
    app.vault.seed("t.timeline", XML, 9000);
    await priv.checkExternalXml();
    await priv.checkExternalXml();
    expect(Notice.messages().filter((m) => m.includes("changed externally"))).toHaveLength(1);
    expect(plugin.settings.lastSeenXmlFingerprint).toBeTruthy(); // baseline recorded for next time
    await vi.waitFor(() => expect(app.vault.files.has("Timeline events/_logs/timeline-sync.log")).toBe(true));
    expect(app.vault.text("Timeline events/_logs/timeline-sync.log")).toContain("external-xml-change");
  });

  it("recognises a touched-but-identical file and adopts the new mtime quietly", async () => {
    app.vault.seed("t.timeline", XML, 9000);
    const { contentFingerprint } = await import("../src/obsidian/sync-policy");
    plugin.settings.lastSeenXmlFingerprint = contentFingerprint(XML);
    await priv.checkExternalXml();
    expect(plugin.settings.lastWrittenXmlMtime).toBe(9000);
    expect(Notice.messages()).toEqual([]);
  });

  it("reports a change against an existing baseline without re-recording it", async () => {
    app.vault.seed("t.timeline", XML, 9000);
    plugin.settings.lastSeenXmlFingerprint = "different";
    await priv.checkExternalXml();
    expect(plugin.settings.lastSeenXmlFingerprint).toBe("different");
    expect(Notice.messages().some((m) => m.includes("changed externally"))).toBe(true);
  });

  it("waits for a file it cannot read right now, and re-arms the announcement when things settle", async () => {
    app.vault.seed("t.timeline", XML, 9000);
    app.vault.failNext.set("read", new Error("mid-sync"));
    await priv.checkExternalXml();
    expect(Notice.messages()).toEqual([]);
    await priv.checkExternalXml();
    expect(priv.externalChangeAnnounced).toBe(true);
    plugin.settings.lastWrittenXmlMtime = 9000;
    await priv.checkExternalXml();
    expect(priv.externalChangeAnnounced).toBe(false);
  });

  it("is polled every 30 seconds", async () => {
    app.vault.seed("t.timeline", XML, 9000);
    await settle(30_000);
    await vi.waitFor(() => expect(Notice.messages().some((m) => m.includes("changed externally"))).toBe(true));
  });
});

describe("sync log", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true });
    await plugin.onload();
  });

  it("appends tab-separated lines, creating the folder and file", async () => {
    await plugin.appendSyncLog("evt", "a.md", "detail");
    await plugin.appendSyncLog("evt2", "b.md", "more");
    const text = app.vault.text("Timeline events/_logs/timeline-sync.log");
    expect(text.split("\n").filter(Boolean)).toEqual([
      "2024-01-01T00:00:00.000Z\tevt\ta.md\tdetail",
      "2024-01-01T00:00:00.000Z\tevt2\tb.md\tmore",
    ]);
  });

  it("rotates a log that has grown past ~200KB", async () => {
    app.vault.seed("Timeline events/_logs/timeline-sync.log", "x".repeat(250_000));
    await plugin.appendSyncLog("evt", "a", "d");
    expect(app.vault.text("Timeline events/_logs/timeline-sync.log").length).toBeLessThan(110_000);
  });

  it("does nothing when disabled, and never throws when writing fails", async () => {
    plugin.settings.syncLogEnabled = false;
    await plugin.appendSyncLog("evt", "a", "d");
    expect(app.vault.files.has("Timeline events/_logs")).toBe(false);
    plugin.settings.syncLogEnabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setLogLevel("warn");
    app.vault.failNext.set("createFolder", new Error("denied"));
    await expect(plugin.appendSyncLog("evt", "a", "d")).resolves.toBeUndefined();
  });
});

describe("settings plumbing", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true, sourceXmlPath: "t.timeline" });
    await plugin.onload();
  });

  it("saves settings with the safety state and refreshes caches and the debounce", async () => {
    plugin.settings.logLevel = "debug";
    const reset = vi.spyOn(priv.cache as unknown as { resetIndex(): void }, "resetIndex");
    await plugin.saveSettings();
    expect(raw().data).toMatchObject({ logLevel: "debug", __safety: { crashDisabled: false } });
    expect(reset).toHaveBeenCalled();
    const bare = create();
    bare.settings.logLevel = "error";
    await bare.saveSettings(); // before onload: no cache or debounce to refresh
  });

  it("applySchemaAffectingChange syncs first when an XML exists, applies the change and says what to do", async () => {
    app.vault.seed("t.timeline", XML);
    app.vault.seed("Timeline events/a.md", note("a"));
    await plugin.applySchemaAffectingChange(() => {
      plugin.settings.mirrorNames.start = "begin";
    });
    expect(plugin.settings.mirrorNames.start).toBe("begin");
    expect(Notice.messages().pop()).toContain("Setting changed. Run");
    expect(app.vault.text("t.timeline")).toContain("<text>a</text>");
  });

  it("skips the pre-change sync when there is no XML, and when it fails", async () => {
    await plugin.applySchemaAffectingChange(() => {});
    app.vault.seed("t.timeline", "<not xml");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setLogLevel("warn");
    await plugin.applySchemaAffectingChange(() => {
      plugin.settings.mirrorNames.end = "stop";
    });
    expect(plugin.settings.mirrorNames.end).toBe("stop");
    const bare = create();
    await bare.applySchemaAffectingChange(() => {}); // before onload: no vault yet
  });

  it("runs a command by id, and prunes backups", async () => {
    plugin.runCommand("txs-import");
    expect(app.executedCommands).toEqual(["timeline-xml-sync:txs-import"]);
    app.vault.seed("t.timeline.bak-1", "", 1);
    app.vault.seed("t.timeline.bak-2", "", 2);
    expect(await plugin.runVaultPrune("xml", "t.timeline", 1)).toBe(1);
    app.vault.seed("Timeline events/_backups/wipe-1/f.md");
    app.vault.seed("Timeline events/_backups/wipe-2/f.md");
    expect(await plugin.runVaultPrune("folder", "wipe", 1)).toBe(1);
  });

  it("the sync-log hook given to commands writes through to the log", async () => {
    await (priv.commandsCtx as unknown as { appendSyncLog(e: string, p: string, d: string): Promise<void> }).appendSyncLog("evt", "a", "d");
    expect(app.vault.text("Timeline events/_logs/timeline-sync.log")).toContain("evt");
  });

  it("the diagnostics bus stores and returns what validation found", () => {
    priv.commandsCtx.setDiagnostics(["a: b"]);
    expect(priv.commandsCtx.getDiagnostics()).toEqual(["a: b"]);
    expect(plugin.diagnostics).toEqual(["a: b"]);
    void priv.commandsCtx.saveSettings();
  });
});

describe("runtime crash guard", () => {
  beforeEach(async () => {
    create({ firstRunCompleted: true });
    await plugin.onload();
  });

  it("returns the handler's value, and swallows errors until the third", async () => {
    const ok = priv.guarded((n: number) => n * 2, "p");
    expect(await ok(2)).toBe(4);
    const bad = priv.guarded(() => {
      throw new Error("x");
    }, "render");
    expect(await bad()).toBeUndefined();
    expect(await bad()).toBeUndefined();
    expect(priv.safety.crashDisabled).toBe(false);
    expect(await bad()).toBeUndefined();
    expect(priv.safety.crashDisabled).toBe(true);
    expect(Notice.messages().pop()).toBe("Timeline XML Sync hit repeated errors — auto-disabled for next start.");
  });

  it("hands the post-processor working settings, click routers and log hook", async () => {
    const ctx = processorCtx[processorCtx.length - 1];
    expect((ctx.getSettings() as { sourceXmlPath: string }).sourceXmlPath).toBe(plugin.settings.sourceXmlPath);
    const click = vi.spyOn(plugin, "onEventClick").mockImplementation(() => {});
    const era = vi.spyOn(plugin, "onEraClick").mockImplementation(() => {});
    ctx.onEventClick("e1");
    ctx.onEraClick("r1");
    expect(click).toHaveBeenCalledWith("e1");
    expect(era).toHaveBeenCalledWith("r1");
  });

  it("hands the views and the inspector working callbacks", async () => {
    const timeline = raw().views.get(VIEW_TYPE_TIMELINE)!(new WorkspaceLeaf()) as { args: Record<string, (...a: unknown[]) => unknown> };
    const click = vi.spyOn(plugin, "onEventClick").mockImplementation(() => {});
    const era = vi.spyOn(plugin, "onEraClick").mockImplementation(() => {});
    expect(timeline.args.getSettings()).toBe(plugin.settings);
    timeline.args.onEventClick("e1");
    timeline.args.onEraClick("r1");
    expect(click).toHaveBeenCalledWith("e1");
    expect(era).toHaveBeenCalledWith("r1");

    const inspector = raw().views.get(VIEW_TYPE_INSPECTOR)!(new WorkspaceLeaf()) as { args: Record<string, (...a: unknown[]) => unknown> };
    expect(inspector.args.getSettings()).toBe(plugin.settings);
    expect(await inspector.args.withSelfWrite(async () => 7)).toBe(7);
    const refresh = vi.spyOn(plugin, "refreshTimelineViews").mockImplementation(() => {});
    inspector.args.onEventSaved();
    expect(refresh).toHaveBeenCalled();
  });

  it("the new-era command starts the era flow", async () => {
    const spy = vi.spyOn(plugin, "createEraInteractive").mockResolvedValue();
    cmd("txs-create-era").callback();
    expect(spy).toHaveBeenCalled();
  });

  it("guards the code-block processor", async () => {
    const proc = raw().codeBlockProcessors.get("timeline")!;
    for (let i = 0; i < 3; i++) await proc("", null, null);
    expect(priv.safety.crashDisabled).toBe(true);
  });
});
