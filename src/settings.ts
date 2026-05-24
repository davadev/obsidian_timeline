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
}

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
  autoSyncDebounceMs: 1500,
  logLevel: "info",
};
