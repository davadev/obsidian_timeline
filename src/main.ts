import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  SuggestModal,
  TAbstractFile,
  TFile,
  normalizePath,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  EVENT_NOTE_SCHEMA_VERSION,
  type TimelineXmlSyncSettings,
} from "./settings";
import { TimelineXmlSyncSettingTab } from "./settings-tab";
import { VaultAdapter } from "./obsidian/vault-adapter";
import { TemplateService } from "./obsidian/template-service";
import { TimelineCache } from "./obsidian/cache";
import { TimelineView, VIEW_TYPE_TIMELINE } from "./obsidian/timeline-view";
import { InspectorView, VIEW_TYPE_INSPECTOR } from "./obsidian/inspector-view";
import {
  effectiveAutoSync,
  getDeviceSyncMode,
  setDeviceSyncMode,
} from "./obsidian/device-prefs";
import {
  registerCommands,
  regenerateXml,
  type CommandsContext,
} from "./obsidian/commands";
import { makeTimelineProcessor } from "./obsidian/markdown-postprocessor";
import { debounce } from "./timeline/sync-engine";

/**
 * Persisted alongside settings (under the same data.json key) so a crash on
 * one device is remembered the next time Obsidian opens — important on iOS
 * where a hard crash can leave a plugin caught in a load loop.
 */
interface SafetyState {
  crashDisabled: boolean;
  lastError?: string;
}

const SAFETY_DEFAULTS: SafetyState = { crashDisabled: false };
const MAX_RUNTIME_CRASHES = 3;

export default class TimelineXmlSyncPlugin extends Plugin {
  settings: TimelineXmlSyncSettings = DEFAULT_SETTINGS;
  diagnostics: string[] = [];
  private safety: SafetyState = { ...SAFETY_DEFAULTS };
  private runtimeCrashes = 0;

  private vault!: VaultAdapter;
  private templates!: TemplateService;
  private cache!: TimelineCache;
  private commandsCtx!: CommandsContext;
  private writingPaths = new Set<string>();
  private debouncedSync?: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (this.safety.crashDisabled) {
      // Safe mode: register only the re-enable command, skip everything else.
      this.installSafeMode();
      return;
    }

    try {
      await this.fullOnload();
    } catch (e) {
      console.error("[Timeline XML Sync] onload crash:", e);
      await this.tripSafetyNet(e as Error, "onload");
      this.installSafeMode();
    }
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TIMELINE);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_INSPECTOR);
  }

  /**
   * Tell every open TimelineView to re-load `cachedDoc` and re-render the
   * body. Triggered after the inspector saves, after the new-event flow
   * creates a note, and similar mutations — keeps the global view's filter
   * (e.g. a search for "Test") from missing freshly added events.
   */
  refreshTimelineViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
    for (const leaf of leaves) {
      if (leaf.view instanceof TimelineView) {
        void leaf.view.refreshFromCache();
      }
    }
  }

  async activateInspector(eventId?: string): Promise<InspectorView | null> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_INSPECTOR)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (!right) return null;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_INSPECTOR, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view instanceof InspectorView ? leaf.view : null;
    if (view && eventId) await view.loadEvent(eventId);
    return view;
  }

  /**
   * Renderer click router. Replaces the previous "open MD on click" behavior.
   * When the user prefers the old behavior they can switch clickBehavior in
   * settings. Inspector view is opened on demand; if it can't be opened
   * (e.g. right sidebar disabled on mobile in a corner case) we fall back to
   * opening the note.
   */
  onEventClick(eventId: string): void {
    if (this.settings.clickBehavior === "open-note") {
      const path = this.cache.resolvePath(eventId);
      if (path) this.app.workspace.openLinkText(path, "", false);
      return;
    }
    void this.activateInspector(eventId).then((view) => {
      if (!view) {
        const path = this.cache.resolvePath(eventId);
        if (path) this.app.workspace.openLinkText(path, "", false);
      }
    });
  }

  /**
   * Click router for era bands / chips / list entries. Mirrors onEventClick:
   * inspector by default (now with a dedicated era form), open-note fallback.
   */
  /** Launch the add-era modal, write its MD note, open inspector. */
  async createEraInteractive(): Promise<void> {
    try {
      await this.templates.createNewEraInteractive(this.vault, async (eraId) => {
        await new Promise((r) => setTimeout(r, 200));
        this.cache.invalidateMdDoc();
        await this.activateInspector();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_INSPECTOR)[0];
        const view = leaf?.view instanceof InspectorView ? leaf.view : null;
        if (view) await view.loadEra(eraId);
        this.refreshTimelineViews();
      });
    } catch (e) {
      new Notice(`Era create failed: ${(e as Error).message}`);
    }
  }

  /**
   * Native SuggestModal that lists the three "create" / "insert" actions.
   * Keeps the ribbon to a single icon while remaining discoverable.
   */
  openTimelineActionPicker(): void {
    type Action = { label: string; description: string; run: () => void };
    const actions: Action[] = [
      {
        label: "New timeline event",
        description: "Prompt + create event note + open inspector.",
        run: () => void this.commandsCtx.createEventInteractive(),
      },
      {
        label: "New era",
        description: "Prompt + create era note + open inspector.",
        run: () => void this.createEraInteractive(),
      },
      {
        label: "Insert timeline view block",
        description: "Insert ```timeline mode: hybrid``` at the editor cursor.",
        run: () => this.insertTimelineBlock(),
      },
    ];
    try {
      new TimelineActionPicker(this.app, actions).open();
    } catch (e) {
      console.error("[Timeline XML Sync] action picker failed:", e);
      new Notice(`Timeline picker failed: ${(e as Error).message}`);
    }
  }

  /** Insert a default ```timeline block at the cursor of the active editor. */
  insertTimelineBlock(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note first.");
      return;
    }
    const editor = view.editor;
    // The block inherits the host note's frontmatter timeline.start/end only
    // when the note explicitly declares `timeline.role: viewport`. Event /
    // ordinary notes no longer auto-restrict the rendered events — same
    // behaviour as the global Timeline view. Set `viewport: true` to force
    // it on; `viewport: false` to force it off regardless of role.
    const snippet = "```timeline\nmode: hybrid\nsource: main\n```\n";
    editor.replaceSelection(snippet);
  }

  onEraClick(eraId: string): void {
    const eraNotePath = `${this.settings.eventNotesDir}/_eras/${eraId}.md`;
    const openFile = () => {
      if (this.app.vault.getAbstractFileByPath(eraNotePath)) {
        void this.app.workspace.openLinkText(eraNotePath, "", false);
      }
    };
    if (this.settings.clickBehavior === "open-note") {
      openFile();
      return;
    }
    void this.activateInspector().then((view) => {
      if (view) void view.loadEra(eraId);
      else openFile();
    });
  }

  /**
   * Runs once after the very first install. Tries to point the plugin at any
   * pre-existing .timeline XML and Markdown event notes the user already has,
   * so the global view + render blocks start working immediately. If multiple
   * candidates are found the user is asked to pick one.
   */
  private async runFirstInstall(): Promise<void> {
    try {
      const { autoDetectXml, autoDetectEventNotes } = await import("./obsidian/commands");
      await autoDetectXml(this.commandsCtx);
      await autoDetectEventNotes(this.commandsCtx);
    } catch (e) {
      console.warn("[Timeline XML Sync] first-install auto-detect failed:", e);
    } finally {
      this.settings.firstRunCompleted = true;
      await this.persistAll();
    }
  }

  async activateTimelineView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TIMELINE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TIMELINE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async fullOnload(): Promise<void> {
    this.vault = new VaultAdapter(this.app);
    this.cache = new TimelineCache(this.app, () => this.settings);
    this.templates = new TemplateService(this.app, this.vault, () => ({
      templatesDir: this.settings.templatesDir,
      eventNotesDir: this.settings.eventNotesDir,
      timelineId: this.settings.timelineId,
      sourceXmlPath: this.settings.sourceXmlPath,
    }));

    this.commandsCtx = {
      app: this.app,
      plugin: this,
      vault: this.vault,
      templates: this.templates,
      cache: this.cache,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      withSelfWrite: async (fn) => this.withSelfWrite(fn),
      setDiagnostics: (lines) => {
        this.diagnostics = lines;
      },
      createEventInteractive: () =>
        this.templates.createNewEventInteractive(
          async (path) => {
            await this.app.workspace.openLinkText(path, "", false);
          },
          async (eventId, path) => {
            // The note write is processed by Obsidian asynchronously — wait
            // a tick for the metadataCache to index it before the inspector
            // tries to resolve the id, then prime the cache directly.
            await new Promise((r) => setTimeout(r, 200));
            this.cache.updateFile(path);
            this.cache.invalidateMdDoc();
            await this.activateInspector(eventId);
            this.refreshTimelineViews();
          }
        ),
    };

    registerCommands(this.commandsCtx);

    this.registerMarkdownCodeBlockProcessor(
      "timeline",
      this.guarded(
        makeTimelineProcessor({
          app: this.app,
          vault: this.vault,
          cache: this.cache,
          getSettings: () => this.settings,
          onEventClick: (id) => this.onEventClick(id),
          onEraClick: (id) => this.onEraClick(id),
        }),
        "render"
      )
    );

    this.addSettingTab(new TimelineXmlSyncSettingTab(this.app, this));

    // Workspace leaf view (like the Graph view) for full-window timeline.
    const viewArgs = {
      app: this.app,
      cache: this.cache,
      getSettings: () => this.settings,
      onEventClick: (id: string) => this.onEventClick(id),
      onEraClick: (id: string) => this.onEraClick(id),
    };
    this.registerView(VIEW_TYPE_TIMELINE, (leaf) => new TimelineView(leaf, viewArgs));
    this.addRibbonIcon("calendar-range", "Open Timeline view", () => {
      void this.activateTimelineView();
    });
    // Single consolidated picker for "create" / "insert" actions so the
    // ribbon stays tidy. The individual commands remain registered below for
    // hotkey bindings and the command palette.
    this.addRibbonIcon("plus-circle", "Timeline actions…", () => {
      this.openTimelineActionPicker();
    });
    this.addCommand({
      id: "txs-create-era",
      name: "New era (prompt + open inspector)",
      callback: () => void this.createEraInteractive(),
    });
    this.addCommand({
      id: "txs-insert-block",
      name: "Insert timeline view block at cursor",
      callback: () => this.insertTimelineBlock(),
    });
    this.addCommand({
      id: "txs-open-view",
      name: "Open Timeline view",
      callback: () => void this.activateTimelineView(),
    });

    // Right-sidebar Inspector for editing an event without leaving the note.
    const inspectorArgs = {
      app: this.app,
      cache: this.cache,
      vault: this.vault,
      getSettings: () => this.settings,
      withSelfWrite: <T,>(fn: () => Promise<T>) => this.withSelfWrite(fn),
      onEventSaved: () => this.refreshTimelineViews(),
    };
    this.registerView(
      VIEW_TYPE_INSPECTOR,
      (leaf) => new InspectorView(leaf, inspectorArgs)
    );
    this.addCommand({
      id: "txs-open-inspector",
      name: "Open Timeline inspector",
      callback: () => void this.activateInspector(),
    });

    this.addCommand({
      id: "txs-export-with-image",
      name: "Export note: render timelines to images",
      callback: () =>
        import("./obsidian/export").then(({ exportActiveNoteWithRenderedTimeline }) =>
          exportActiveNoteWithRenderedTimeline({
            app: this.app,
            vault: this.vault,
            cache: this.cache,
            getSettings: () => this.settings,
            withSelfWrite: (fn) => this.withSelfWrite(fn),
          })
        ),
    });

    this.rebuildDebouncedSync();
    this.registerEvent(
      this.app.vault.on("create", (f) => this.onVaultEvent("create", f))
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.onVaultEvent("modify", f))
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.onVaultEvent("delete", f))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) =>
        this.onVaultEvent("rename", f, oldPath)
      )
    );
    // Coalesce metadataCache events — Obsidian fires "changed" eagerly during
    // typing. We collect paths and flush once per 250 ms on the microtask queue.
    const pendingMetaUpdates = new Set<string>();
    let metaFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushMeta = () => {
      metaFlushTimer = null;
      for (const p of pendingMetaUpdates) this.cache.updateFile(p);
      pendingMetaUpdates.clear();
      this.cache.invalidateMdDoc();
    };
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        pendingMetaUpdates.add(f.path);
        if (!metaFlushTimer) metaFlushTimer = setTimeout(flushMeta, 250);
      })
    );

    // First-run mobile default: force sync off so phones can install without
    // accidentally rewriting the XML (which often isn't there or isn't writable).
    if (Platform.isMobile && getDeviceSyncMode() === "global") {
      setDeviceSyncMode("off");
      new Notice(
        "Timeline XML Sync: auto-sync turned off on this device by default. Re-enable in Settings → Auto-sync on this device.",
        8000
      );
    }

    // Pre-warm the id index so the first render is fast.
    this.cache.buildIndex();

    // First-install auto-detect: find XML + event notes dir, store, run import
    // if both look fresh. Runs once — gated by settings.firstRunCompleted.
    if (!this.settings.firstRunCompleted) {
      // Defer so onload returns quickly — the work happens in the background.
      setTimeout(() => void this.runFirstInstall(), 800);
    }

    // One-shot notice if the on-disk notes were written by an older schema.
    if (
      this.settings.lastImportSchemaVersion > 0 &&
      this.settings.lastImportSchemaVersion < EVENT_NOTE_SCHEMA_VERSION
    ) {
      new Notice(
        `Timeline XML Sync: event note schema changed (v${this.settings.lastImportSchemaVersion} → v${EVENT_NOTE_SCHEMA_VERSION}). Run "Wipe event notes and reimport from XML" to refresh.`,
        12000
      );
    }
  }

  private installSafeMode(): void {
    const msg = this.safety.lastError
      ? `Timeline XML Sync auto-disabled after a crash: ${this.safety.lastError}`
      : "Timeline XML Sync auto-disabled after a crash.";
    new Notice(msg, 8000);
    this.addCommand({
      id: "txs-reenable",
      name: "Re-enable Timeline XML Sync (clear crash flag)",
      callback: async () => {
        this.safety = { ...SAFETY_DEFAULTS };
        await this.persistAll();
        new Notice("Crash flag cleared. Reload Obsidian to re-enable.");
      },
    });
  }

  private async tripSafetyNet(err: Error, phase: string): Promise<void> {
    this.safety.crashDisabled = true;
    this.safety.lastError = `[${phase}] ${err.message ?? String(err)}`.slice(0, 240);
    try {
      await this.persistAll();
    } catch {
      // last-ditch — nothing else to do
    }
  }

  /** Wrap an arbitrary handler so runtime crashes bump a counter and, after
   * MAX_RUNTIME_CRASHES, persist the crash flag for next start. */
  private guarded<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
    phase: string
  ): (...args: A) => Promise<R | undefined> {
    return async (...args: A) => {
      try {
        return await fn(...args);
      } catch (e) {
        console.error(`[Timeline XML Sync] ${phase} error:`, e);
        this.runtimeCrashes++;
        if (this.runtimeCrashes >= MAX_RUNTIME_CRASHES) {
          await this.tripSafetyNet(e as Error, phase);
          new Notice(
            "Timeline XML Sync hit repeated errors — auto-disabled for next start.",
            10000
          );
        }
        return undefined;
      }
    };
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as
      | (Partial<TimelineXmlSyncSettings> & { __safety?: SafetyState })
      | null;
    this.settings = mergeSettings(DEFAULT_SETTINGS, stored);
    this.safety = {
      ...SAFETY_DEFAULTS,
      ...(stored?.__safety ?? {}),
    };
  }

  async saveSettings(): Promise<void> {
    await this.persistAll();
    if (this.debouncedSync) this.rebuildDebouncedSync();
    // Re-prime caches when paths or scan-source change.
    if (this.cache) {
      this.cache.resetIndex();
      this.cache.invalidateMdDoc();
    }
  }

  /**
   * Wrapper for settings tab to call when changing settings that affect the
   * on-disk note schema (mirror names, eventNotesDir, etc). Forces a Markdown
   * → XML sync first (so the old layout is captured), saves the new setting,
   * then prompts the user to run the wipe-and-reimport command so the notes
   * match the new schema.
   */
  async applySchemaAffectingChange(mutate: () => void): Promise<void> {
    try {
      const { regenerateXml } = await import("./obsidian/commands");
      // Best-effort pre-save sync (silently skipped if there's no XML yet).
      if (this.settings.sourceXmlPath && this.vault?.exists(this.settings.sourceXmlPath)) {
        await regenerateXml(this.commandsCtx);
      }
    } catch (e) {
      console.warn("[Timeline XML Sync] pre-change sync skipped:", e);
    }
    mutate();
    await this.saveSettings();
    new Notice(
      "Setting changed. Run \"Wipe event notes and reimport from XML\" to refresh notes to the new schema.",
      9000
    );
  }

  private async persistAll(): Promise<void> {
    await this.saveData({ ...this.settings, __safety: this.safety });
  }

  runCommand(id: string): void {
    (this.app as unknown as {
      commands: { executeCommandById: (id: string) => boolean };
    }).commands.executeCommandById(`${this.manifest.id}:${id}`);
  }

  private async withSelfWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.writingPaths.add("__SELF__");
    try {
      return await fn();
    } finally {
      setTimeout(() => this.writingPaths.delete("__SELF__"), 300);
    }
  }

  private rebuildDebouncedSync(): void {
    this.debouncedSync = debounce(() => {
      regenerateXml(this.commandsCtx).catch((e) => {
        console.error("[Timeline XML Sync] auto-sync error:", e);
        new Notice(`Timeline auto-sync error: ${(e as Error).message}`);
      });
    }, this.settings.autoSyncDebounceMs);
  }

  private onVaultEvent(
    kind: "create" | "modify" | "delete" | "rename",
    file: TAbstractFile,
    oldPath?: string
  ): void {
    try {
      if (!(file instanceof TFile)) return;
      const dir = normalizePath(this.settings.eventNotesDir);
      const inDir = (p: string) => p === dir || p.startsWith(dir + "/");
      // Maintain the id index incrementally — cheap.
      if (kind === "delete") {
        this.cache.removeFile(file.path);
      } else if (kind === "rename" && oldPath) {
        this.cache.removeFile(oldPath);
        this.cache.updateFile(file.path);
      } else {
        this.cache.updateFile(file.path);
      }
      // Auto-sync trigger gating (per-device override takes precedence).
      if (!effectiveAutoSync(this.settings.autoSync)) return;
      if (this.writingPaths.has("__SELF__")) return;
      if (file.extension !== "md") return;
      if (!inDir(file.path) && !(oldPath && inDir(oldPath))) return;
      this.debouncedSync?.();
    } catch (e) {
      console.error("[Timeline XML Sync] vault-event handler error:", e);
      this.runtimeCrashes++;
      if (this.runtimeCrashes >= MAX_RUNTIME_CRASHES) {
        void this.tripSafetyNet(e as Error, "vault-event");
      }
    }
  }
}

class TimelineActionPicker extends SuggestModal<{
  label: string;
  description: string;
  run: () => void;
}> {
  constructor(
    app: ConstructorParameters<typeof SuggestModal>[0],
    private actions: { label: string; description: string; run: () => void }[]
  ) {
    super(app);
    this.setPlaceholder("Pick a Timeline action…");
  }
  getSuggestions(query: string) {
    const q = query.toLowerCase();
    return this.actions.filter(
      (a) =>
        !q ||
        a.label.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
    );
  }
  renderSuggestion(a: { label: string; description: string }, el: HTMLElement) {
    el.createEl("div", { text: a.label, cls: "txs-picker-title" });
    el.createEl("div", { text: a.description, cls: "txs-picker-desc" });
  }
  onChooseSuggestion(a: { run: () => void }) {
    a.run();
  }
}

function mergeSettings(
  base: TimelineXmlSyncSettings,
  loaded: unknown
): TimelineXmlSyncSettings {
  if (!loaded || typeof loaded !== "object") return { ...base };
  const l = loaded as Partial<TimelineXmlSyncSettings>;
  return {
    ...base,
    ...l,
    mirrorNames: { ...base.mirrorNames, ...(l.mirrorNames ?? {}) },
    renderDefaults: { ...base.renderDefaults, ...(l.renderDefaults ?? {}) },
    categoryColors: { ...(l.categoryColors ?? {}) },
    knownCategories: Array.isArray(l.knownCategories) ? l.knownCategories : [],
  };
}
