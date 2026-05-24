import { Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type TimelineXmlSyncSettings,
} from "./settings";
import { TimelineXmlSyncSettingTab } from "./settings-tab";
import { VaultAdapter } from "./obsidian/vault-adapter";
import { TemplateService } from "./obsidian/template-service";
import {
  registerCommands,
  regenerateXml,
  type CommandsContext,
} from "./obsidian/commands";
import { makeTimelineProcessor } from "./obsidian/markdown-postprocessor";
import { debounce } from "./timeline/sync-engine";

export default class TimelineXmlSyncPlugin extends Plugin {
  settings: TimelineXmlSyncSettings = DEFAULT_SETTINGS;
  diagnostics: string[] = [];

  private vault!: VaultAdapter;
  private templates!: TemplateService;
  private commandsCtx!: CommandsContext;
  /** Set of vault paths the plugin is currently writing — to skip self-triggered events. */
  private writingPaths = new Set<string>();
  private debouncedSync?: () => void;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.vault = new VaultAdapter(this.app);
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
      getSettings: () => this.settings,
      withSelfWrite: async (fn) => this.withSelfWrite(fn),
      setDiagnostics: (lines) => {
        this.diagnostics = lines;
      },
    };

    registerCommands(this.commandsCtx);

    this.registerMarkdownCodeBlockProcessor(
      "timeline",
      makeTimelineProcessor({
        app: this.app,
        vault: this.vault,
        getSettings: () => this.settings,
      })
    );

    this.addSettingTab(new TimelineXmlSyncSettingTab(this.app, this));

    // Auto-sync wiring
    this.rebuildDebouncedSync();
    this.registerEvent(this.app.vault.on("create", (f) => this.maybeQueueSync(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => this.maybeQueueSync(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.maybeQueueSync(f)));
    this.registerEvent(
      this.app.vault.on("rename", (f) => this.maybeQueueSync(f))
    );
  }

  onunload(): void {}

  async loadSettings(): Promise<void> {
    const stored = await this.loadData();
    this.settings = mergeSettings(DEFAULT_SETTINGS, stored);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.rebuildDebouncedSync();
  }

  runCommand(id: string): void {
    (this.app as unknown as { commands: { executeCommandById: (id: string) => boolean } })
      .commands.executeCommandById(`${this.manifest.id}:${id}`);
  }

  /** Track plugin-originated writes so we can ignore them in change handlers. */
  private async withSelfWrite<T>(fn: () => Promise<T>): Promise<T> {
    const before = new Set(this.writingPaths);
    // We don't know the exact paths up-front; instead, wrap any write through
    // VaultAdapter by setting a session-wide flag. The handler checks the flag.
    this.writingPaths.add("__SELF__");
    try {
      return await fn();
    } finally {
      // Restore previous set (preserves nested calls).
      this.writingPaths = before;
      // Clear after a short tick so trailing vault events are still suppressed.
      setTimeout(() => this.writingPaths.delete("__SELF__"), 200);
      this.writingPaths.delete("__SELF__");
    }
  }

  private rebuildDebouncedSync(): void {
    this.debouncedSync = debounce(() => {
      regenerateXml(this.commandsCtx).catch((e) => {
        console.error("[Timeline XML Sync] auto-sync error:", e);
        this.vault.notice(`Timeline auto-sync error: ${(e as Error).message}`);
      });
    }, this.settings.autoSyncDebounceMs);
  }

  private maybeQueueSync(file: TAbstractFile): void {
    if (!this.settings.autoSync) return;
    if (this.writingPaths.has("__SELF__")) return;
    if (!(file instanceof TFile)) return;
    const dir = normalizePath(this.settings.eventNotesDir);
    if (!dir) return;
    if (file.path !== dir && !file.path.startsWith(dir + "/")) return;
    if (file.extension !== "md") return;
    this.debouncedSync?.();
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
  };
}
