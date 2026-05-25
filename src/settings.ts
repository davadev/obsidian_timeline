import {
  DEFAULT_MIRROR_NAMES,
  type MirrorPropertyNames,
} from "./timeline/model";
import {
  DEFAULT_RENDER_OPTIONS,
  type RenderOptions,
} from "./renderer/render-options";

export interface TimelineXmlSyncSettings {
  /** Vault-relative path to the .timeline XML save file. */
  sourceXmlPath: string;
  /** Vault-relative folder where event Markdown notes live. */
  eventNotesDir: string;
  /** Vault-relative folder for the plugin-managed templates (optional). */
  templatesDir: string;
  /** Logical id for this timeline (matches `timeline.id` in frontmatter). */
  timelineId: string;
  /** Top-level mirror property names. */
  mirrorNames: MirrorPropertyNames;
  /** Defaults applied to ```timeline blocks that omit fields. */
  renderDefaults: RenderOptions;
  /** Category name → CSS color string. */
  categoryColors: Record<string, string>;
  /** Backup .timeline before regenerating. */
  backupEnabled: boolean;
  /** Sync writes the XML automatically after Markdown changes. */
  autoSync: boolean;
  /** Debounce window before auto-sync fires. */
  autoSyncDebounceMs: number;
  /** "error" | "warn" | "info" | "debug" */
  logLevel: "error" | "warn" | "info" | "debug";
  /** Known category names — populated on XML import for the settings UI. */
  knownCategories: string[];
  /** Last event-note schema version that wrote the existing notes. */
  lastImportSchemaVersion: number;
  /**
   * Years added on each side of a degenerate (zero-span) viewport so that
   * single-point event notes still show neighbouring range events.
   * Per-block override: `pointPaddingYears: <n>`.
   */
  pointPaddingYears: number;
  /** Categories hidden by default (global filter). Per-block include/exclude wins. */
  hiddenCategories: string[];
  /**
   * Where to read events from when rendering ` ```timeline ` blocks.
   * - "xml": always use the configured XML file. Fail if missing.
   * - "md": always build the event list from Markdown notes in eventNotesDir.
   * - "auto": prefer XML when it exists, fall back to MD scan otherwise.
   *
   * The auto + md modes are what make the plugin useful on iOS when you only
   * have Markdown notes synced (no Timeline Project XML available).
   */
  eventSource: "xml" | "md" | "auto";
  /** Set on first successful install. Suppresses the first-run auto-detect. */
  firstRunCompleted: boolean;
}

/**
 * Bumped whenever the canonical Markdown event-note layout changes in a way
 * that older notes can no longer round-trip safely. The plugin compares this
 * to `settings.lastImportSchemaVersion` on load — if it has moved forward the
 * user is offered the safe reimport command (which wipes + re-creates notes
 * from the still-canonical .timeline XML).
 */
export const EVENT_NOTE_SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS: TimelineXmlSyncSettings = {
  sourceXmlPath: "timelines/main.timeline",
  eventNotesDir: "Timeline events",
  templatesDir: "Templates",
  timelineId: "main",
  mirrorNames: { ...DEFAULT_MIRROR_NAMES },
  renderDefaults: { ...DEFAULT_RENDER_OPTIONS },
  categoryColors: {},
  backupEnabled: true,
  autoSync: true,
  autoSyncDebounceMs: 60_000,
  logLevel: "info",
  knownCategories: [],
  lastImportSchemaVersion: 0,
  pointPaddingYears: 100,
  hiddenCategories: [],
  eventSource: "auto",
  firstRunCompleted: false,
};
