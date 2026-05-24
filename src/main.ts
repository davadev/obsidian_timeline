import { Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type TimelineXmlSyncSettings,
} from "./settings";
import { TimelineXmlSyncSettingTab } from "./settings-tab";
import { VaultAdapter } from "./obsidian/vault-adapter";
import { TemplateService } from "./obsidian/template-service";
import { TimelineCache } from "./obsidian/cache";
import { effectiveAutoSync } from "./obsidian/device-prefs";
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

  onunload(): void {}

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
        }),
        "render"
      )
    );

    this.addSettingTab(new TimelineXmlSyncSettingTab(this.app, this));

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
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) =>
        this.cache.updateFile(f.path)
      )
    );

    // Pre-warm the id index so the first render is fast.
    this.cache.buildIndex();
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
    // Re-prime caches when paths change.
    if (this.cache) this.cache.resetIndex();
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
