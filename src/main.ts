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
  resolveLogFolder,
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
import { setLogLevel } from "./logger";
import { initDeviceStore } from "./obsidian/app-storage";

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
  /** Per-path expiry stamps for self-write suppression. `__SELF__` is a global fallback. */
  private recentSelfWrites = new Map<string, number>();
  private debouncedSync?: () => void;
  /** Wall-clock epoch-ms when fullOnload finished. Auto-sync defers until startup grace elapses. */
  private loadedAt = 0;
  /** One-shot guard so external-XML-change Notice does not repeat every tick. */
  private externalChangeAnnounced = false;

  async onload(): Promise<void> {
    // Device-local storage (per-device sync mode, saved block filters) routes
    // through the App, so register it before anything reads a preference.
    initDeviceStore(this.app);

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
    void this.app.workspace.revealLeaf(leaf);
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
      if (path) void this.app.workspace.openLinkText(path, "", false);
      return;
    }
    void this.activateInspector(eventId).then((view) => {
      if (!view) {
        const path = this.cache.resolvePath(eventId);
        if (path) void this.app.workspace.openLinkText(path, "", false);
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
        await new Promise((r) => window.setTimeout(r, 200));
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
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TIMELINE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  private async fullOnload(): Promise<void> {
    this.loadedAt = Date.now();
    this.vault = new VaultAdapter(this.app);
    this.cache = new TimelineCache(this.app, () => this.settings);
    this.templates = new TemplateService(this.app, this.vault, () => ({
      templatesDir: this.settings.templatesDir,
      eventNotesDir: this.settings.eventNotesDir,
      timelineId: this.settings.timelineId,
      sourceXmlPath: this.settings.sourceXmlPath,
      trimDescriptionOnWrite: this.settings.trimDescriptionOnWrite,
    }));

    this.commandsCtx = {
      app: this.app,
      plugin: this,
      vault: this.vault,
      templates: this.templates,
      cache: this.cache,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      withSelfWrite: async (fn, paths) => this.withSelfWrite(fn, paths),
      appendSyncLog: (event, path, detail) =>
        this.appendSyncLog(event, path, detail),
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
            await new Promise((r) => window.setTimeout(r, 200));
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
          appendSyncLog: (event, path, detail) =>
            this.appendSyncLog(event, path, detail),
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
    this.addRibbonIcon("calendar-range", "Open timeline view", () => {
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
      name: "Open timeline view",
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
      name: "Open timeline inspector",
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
    let metaFlushTimer: number | null = null;
    const flushMeta = () => {
      metaFlushTimer = null;
      for (const p of pendingMetaUpdates) this.cache.updateFile(p);
      pendingMetaUpdates.clear();
      this.cache.invalidateMdDoc();
    };
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        pendingMetaUpdates.add(f.path);
        if (!metaFlushTimer) metaFlushTimer = window.setTimeout(flushMeta, 250);
      })
    );

    // Obsidian parses frontmatter asynchronously and fires "resolved" once it
    // has caught up. Anything indexed before that — at startup, or while
    // remote sync was still landing notes — may have been read with no
    // frontmatter at all, so drop the index and let it rebuild from a warm
    // metadata cache. Without this an event could report "no note found"
    // until the app was restarted.
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.cache.resetIndex();
      })
    );

    // First-run mobile default: force sync off so phones can install without
    // accidentally rewriting the XML (which often isn't there or isn't writable).
    if (Platform.isMobile && getDeviceSyncMode() === "global") {
      setDeviceSyncMode("off");
      new Notice(
        "Timeline XML Sync: auto-sync turned off on this device by default. Re-enable in settings → auto-sync on this device.",
        8000
      );
    }

    // Pre-warm the id index so the first render is fast.
    this.cache.buildIndex();

    // First-install auto-detect: find XML + event notes dir, store, run import
    // if both look fresh. Runs once — gated by settings.firstRunCompleted.
    if (!this.settings.firstRunCompleted) {
      // Defer so onload returns quickly — the work happens in the background.
      window.setTimeout(() => void this.runFirstInstall(), 800);
    }

    // Watch XML mtime so we can notice when remote sync lands a change.
    // Throttled (30s) — vault.on("modify") would also catch it but only on
    // some platforms, and would race with our own writes.
    this.registerInterval(
      window.setInterval(() => void this.checkExternalXml(), 30_000)
    );

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
      name: "Re-enable after crash (clear crash flag)",
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
    setLogLevel(this.settings.logLevel);
    this.safety = {
      ...SAFETY_DEFAULTS,
      ...(stored?.__safety ?? {}),
    };
  }

  async saveSettings(): Promise<void> {
    setLogLevel(this.settings.logLevel);
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
      "Setting changed. Run \"wipe event notes and reimport from XML\" to refresh notes to the new schema.",
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

  /**
   * One-shot pruning entry point used by the settings tab.
   * - kind="xml": `arg` is the XML path; keep `keep` newest .bak-* siblings.
   * - kind="folder": `arg` is the label; keep `keep` newest `_backups/<label>-*` folders.
   */
  async runVaultPrune(
    kind: "xml" | "folder",
    arg: string,
    keep: number
  ): Promise<number> {
    if (kind === "xml") return this.vault.pruneXmlBackups(arg, keep);
    const { resolveBackupFolder } = await import("./settings");
    return this.vault.pruneFolderBackups(arg, keep, resolveBackupFolder(this.settings));
  }

  /**
   * Mark a region of code as a plugin-initiated write so the vault-event
   * handler does not treat the resulting `modify`/`create` events as user
   * edits and trigger a sync loop.
   *
   * If `paths` is provided each one is stamped individually so only events for
   * those paths are suppressed. The `__SELF__` sentinel is always set as a
   * coarse fallback for legacy callers that don't know the target paths.
   *
   * TTL comes from `settings.selfWriteTtlMs` — remote sync (Nextcloud / iCloud)
   * can land a just-written file seconds after the local write, so the old
   * 300ms window was too short and let those landings re-trigger auto-sync.
   */
  async withSelfWrite<T>(fn: () => Promise<T>, paths?: string[]): Promise<T> {
    const ttl = this.settings.selfWriteTtlMs ?? 5000;
    const exp = Date.now() + ttl;
    if (paths) {
      for (const p of paths) this.recentSelfWrites.set(normalizePath(p), exp);
    }
    this.recentSelfWrites.set("__SELF__", exp);
    try {
      return await fn();
    } finally {
      // Lazy-evict expired entries to keep the map small over long sessions.
      window.setTimeout(() => {
        const now = Date.now();
        for (const [k, e] of Array.from(this.recentSelfWrites.entries())) {
          if (e <= now) this.recentSelfWrites.delete(k);
        }
      }, ttl + 100);
    }
  }

  private isSelfWrite(path: string): boolean {
    const now = Date.now();
    const exp = this.recentSelfWrites.get(normalizePath(path));
    if (exp && exp > now) return true;
    const sentinel = this.recentSelfWrites.get("__SELF__");
    return !!(sentinel && sentinel > now);
  }

  /** Append a line to the sync log (best-effort, rotated at ~200KB). */
  async appendSyncLog(event: string, path: string, detail: string): Promise<void> {
    if (!this.settings.syncLogEnabled) return;
    try {
      const logFolder = resolveLogFolder(this.settings);
      const logPath = `${logFolder}/timeline-sync.log`;
      const line = `${new Date().toISOString()}\t${event}\t${path}\t${detail}\n`;
      await this.vault.ensureFolder(logFolder);
      let prev = "";
      if (this.vault.exists(logPath)) {
        prev = await this.vault.readText(logPath);
        if (prev.length > 200_000) prev = prev.slice(-100_000);
      }
      await this.withSelfWrite(
        () => this.vault.writeText(logPath, prev + line),
        [logPath]
      );
    } catch (e) {
      console.warn("[Timeline XML Sync] sync log write failed:", e);
    }
  }

  private async checkExternalXml(): Promise<void> {
    const s = this.settings;
    if (!s.sourceXmlPath) return;
    const mtime = this.vault.getMtime(s.sourceXmlPath);
    if (mtime == null) return;
    // Allow a 2s grace for filesystem mtime quantization.
    if (
      s.lastWrittenXmlMtime != null &&
      mtime > s.lastWrittenXmlMtime + 2000
    ) {
      if (!this.externalChangeAnnounced) {
        new Notice(
          "Timeline XML changed externally (remote sync?). Run \"import XML\" to pick up changes before editing.",
          8000
        );
        this.externalChangeAnnounced = true;
        void this.appendSyncLog(
          "external-xml-change",
          s.sourceXmlPath,
          `mtime=${mtime} vs lastWritten=${s.lastWrittenXmlMtime}`
        );
      }
    } else {
      this.externalChangeAnnounced = false;
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
      if (this.isSelfWrite(file.path)) return;
      if (file.extension !== "md") return;
      if (!inDir(file.path) && !(oldPath && inDir(oldPath))) return;
      // Startup grace: let remote sync (Nextcloud / iCloud) finish its initial
      // pull before we start writing XML. Otherwise auto-sync may fire on a
      // half-pulled state and clobber edits from another device.
      const sinceLoad = Date.now() - this.loadedAt;
      if (sinceLoad < this.settings.autoSyncStartupDelayMs) return;
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
    this.setPlaceholder("Pick a timeline action…");
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
    el.createDiv({ text: a.label, cls: "txs-picker-title" });
    el.createDiv({ text: a.description, cls: "txs-picker-desc" });
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
