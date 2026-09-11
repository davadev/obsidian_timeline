import {
  Notice,
  PluginSettingTab,
  type App,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";
import type TimelineXmlSyncPlugin from "./main";
import { DEFAULT_MIRROR_NAMES } from "./timeline/model";
import { resolveBackupFolder, resolveLogFolder } from "./settings";
import {
  getDeviceSyncMode,
  setDeviceSyncMode,
  type DeviceSyncMode,
} from "./obsidian/device-prefs";

/**
 * Coerce any of the color formats we accept (#rgb, #rrggbb, rgb(r,g,b),
 * rgba(...), hsl(...), bare "r,g,b") into a #rrggbb string suitable for the
 * native <input type="color"> picker. Returns the input unchanged when we
 * can't parse it (the picker will just default to black, no crash).
 */
function toHexColor(raw: string): string {
  const s = raw.trim();
  if (!s) return "#888888";
  const hex6 = s.match(/^#([0-9a-f]{6})$/i);
  if (hex6) return `#${hex6[1].toLowerCase()}`;
  const hex3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) {
    const r = hex3[1] + hex3[1];
    const g = hex3[2] + hex3[2];
    const b = hex3[3] + hex3[3];
    return `#${(r + g + b).toLowerCase()}`;
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return rgbHex(parseInt(rgb[1], 10), parseInt(rgb[2], 10), parseInt(rgb[3], 10));
  }
  const bare = s.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/);
  if (bare) {
    return rgbHex(parseInt(bare[1], 10), parseInt(bare[2], 10), parseInt(bare[3], 10));
  }
  // hsl → rgb → hex
  const hsl = s.match(/^hsla?\(\s*(\d+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i);
  if (hsl) {
    const [r, g, b] = hslToRgb(
      parseInt(hsl[1], 10),
      parseFloat(hsl[2]) / 100,
      parseFloat(hsl[3]) / 100
    );
    return rgbHex(r, g, b);
  }
  return "#888888";
}

function rgbHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const h = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

export class TimelineXmlSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TimelineXmlSyncPlugin) {
    super(app, plugin);
  }

  /**
   * Declarative definitions (Obsidian 1.13+). Obsidian renders these itself
   * and indexes them for settings search, so there is no display() here —
   * every row below is either a `control` (bound through get/setControlValue),
   * an `action` (button), or a `render` callback for the handful of rows that
   * need custom DOM.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;

    return [
      {
        name: "Timeline Project save file",
        desc: this.introFragment(),
        searchable: false,
      },
      {
        type: "group",
        heading: "Paths",
        items: [
          {
            name: "XML save file path",
            desc: "Vault-relative path to the .timeline file.",
            control: {
              type: "text",
              key: "sourceXmlPath",
              placeholder: "timelines/main.timeline",
            },
          },
          {
            name: "Event notes directory",
            desc: "Folder for one-Markdown-file-per-event.",
            control: { type: "text", key: "eventNotesDir" },
          },
          {
            name: "Templates directory",
            desc: "Where the plugin writes its event-note template.",
            control: { type: "text", key: "templatesDir" },
          },
          {
            name: "Timeline ID",
            desc: "Logical ID stored in each event's frontmatter (timeline.id).",
            control: { type: "text", key: "timelineId" },
          },
        ],
      },
      {
        type: "group",
        heading: "Actions",
        items: [
          {
            name: "Import XML → Markdown",
            action: () => this.plugin.runCommand("txs-import"),
          },
          {
            name: "Force regenerate XML from Markdown",
            action: () => this.plugin.runCommand("txs-regenerate"),
          },
          {
            name: "Validate all event notes",
            action: () => this.plugin.runCommand("txs-validate"),
          },
          {
            name: "New timeline event",
            desc: "Recommended path. Prompts for a title, creates the note in the event notes folder, opens it, and reveals the timeline inspector so you can fill in dates / category / description right away.",
            action: () => this.plugin.runCommand("txs-create-event"),
          },
          {
            name: "Create/update Obsidian templates plugin file (advanced)",
            desc: "Writes a template that the core templates plugin can insert. Deprecated for normal use — prefer the new event action above.",
            action: () => this.plugin.runCommand("txs-create-template"),
          },
          {
            name: "Auto-detect event notes (scan vault)",
            desc: "Walks the vault for notes with timeline.enabled: true and points the plugin at the longest common parent folder. Useful first-run action on mobile.",
            action: () => this.plugin.runCommand("txs-auto-detect"),
          },
          {
            name: "Event source for rendering",
            desc: "Auto: prefer XML when present, fall back to a Markdown scan. XML: always read the .timeline XML. Markdown: always build events from Markdown notes (mobile-friendly when XML is not synced).",
            control: {
              type: "dropdown",
              key: "eventSource",
              options: { auto: "Auto", xml: "XML", md: "Markdown" },
            },
          },
          {
            name: "Wipe event notes and reimport from XML",
            desc: "Use after a plugin upgrade that changed the event-note schema. Backs up the XML, deletes every .md in the event notes directory, then reimports.",
            action: () => this.plugin.runCommand("txs-wipe-reimport"),
          },
        ],
      },
      {
        type: "group",
        heading: "Mirror property names",
        items: MIRROR_FIELDS.map((key) => ({
          name: `timeline.${key}`,
          desc: "Schema-affecting — changing this will offer a reimport.",
          control: { type: "text" as const, key: `mirrorNames.${key}` },
        })),
      },
      {
        type: "group",
        heading: "Render defaults",
        items: [
          {
            name: "Default render mode",
            control: {
              type: "dropdown",
              key: "renderDefaults.mode",
              options: { bar: "Bar", list: "List", hybrid: "Hybrid" },
            },
          },
          {
            name: "Default details style",
            control: {
              type: "dropdown",
              key: "renderDefaults.details",
              options: {
                list: "List",
                compact: "Compact",
                table: "Table",
                cards: "Cards",
              },
            },
          },
          {
            name: "Default sort order",
            control: {
              type: "dropdown",
              key: "renderDefaults.sort",
              options: {
                chronological: "Chronological",
                "reverse-chronological": "Reverse chronological",
                category: "Category",
              },
            },
          },
          {
            name: "Click behavior in rendered timelines",
            desc: "What happens when you tap an event in a render block or the timeline view.",
            control: {
              type: "dropdown",
              key: "clickBehavior",
              options: {
                inspector: "Open in the timeline inspector (right sidebar)",
                "open-note": "Open the underlying note",
              },
            },
          },
          {
            name: "Default zoom factor",
            desc: "Multiplier for the time axis. 1 = fits container, 4 = 4× wider (horizontal scroll). Per-block `zoom: N` overrides this.",
            control: {
              type: "number",
              key: "renderDefaults.zoom",
              min: 0.1,
              validate: (v) => (v > 0 ? undefined : "Must be greater than 0."),
            },
          },
          {
            name: "Years of context for single-point notes",
            desc: "When a viewer note's start = end, the viewport is padded by this many years on each side so neighbouring range events are visible. Per-block override: pointPaddingYears: <n>.",
            control: {
              type: "number",
              key: "pointPaddingYears",
              min: 0,
              validate: (v) => (v >= 0 ? undefined : "Must be 0 or more."),
            },
          },
          {
            name: "Fuzzy edge fade length (%)",
            desc: "How far across an event's bar the transparent → opaque gradient stretches when fuzzy_start / fuzzy_end is set. 20 = a 20% sliver at the fuzzy edge fades in. Clamped to 1-49 at render time.",
            control: {
              type: "number",
              key: "fuzzyGradientPercent",
              min: 1,
              max: 49,
              validate: (v) =>
                v >= 1 && v <= 49 ? undefined : "Must be between 1 and 49.",
            },
          },
          {
            name: "Event label color",
            desc: "CSS color (for example white, or rgb(20,20,20)) for the text drawn on top of event bars. Leave empty for the auto-contrast default. Useful when fuzzy gradients leave the label sitting over a faded edge.",
            control: {
              type: "text",
              key: "eventLabelColor",
              placeholder: "Auto — contrast with fill",
            },
          },
          {
            name: "Show in-render filter bar by default",
            desc: "Toggle the category chip bar that appears above each rendered timeline. Per-block override: showFilterUI: false.",
            control: { type: "toggle", key: "renderDefaults.showFilterUI" },
          },
          {
            name: "Global view date filter precision",
            desc: "How many date components the filter row in the timeline view exposes. Year keeps things compact; day or time adds the extra inputs.",
            control: {
              type: "dropdown",
              key: "globalFilterPrecision",
              options: {
                year: "Year only (default)",
                day: "Year + month + day",
                time: "Year + month + day + time",
              },
            },
          },
          {
            name: "Globally hidden categories",
            desc: "Comma-separated list. Hidden by default in every render; the in-render chip bar can re-enable per timeline.",
            control: { type: "text", key: "hiddenCategories" },
          },
          {
            name: "Default orientation",
            control: {
              type: "dropdown",
              key: "renderDefaults.orientation",
              options: { horizontal: "Horizontal", vertical: "Vertical" },
            },
          },
          {
            name: "Default fields shown",
            desc: "Comma-separated: title,date,category,description,tags,links,source",
            control: { type: "text", key: "renderDefaults.show" },
          },
        ],
      },
      {
        type: "group",
        heading: "Category colors",
        items: [
          {
            name: "About category colors",
            desc: "Categories discovered on import are listed here. Colors mirror the XML by default; edit to override. Use a CSS color (for example #88bb55 or rgb(120,180,90)).",
            searchable: false,
          },
          ...this.categoryColorItems(),
        ],
      },
      {
        type: "group",
        heading: "Sync & backup",
        items: [
          {
            name: "Auto-sync Markdown → XML (global)",
            desc: "Vault-wide default. The per-device override below can force this on or off for the current device only.",
            control: { type: "toggle", key: "autoSync" },
          },
          {
            name: "Auto-sync on this device",
            desc: "Stored in this device's local storage — does not sync with the vault. Use 'force off' on phones if only the desktop should write the .timeline file.",
            control: {
              type: "dropdown",
              key: DEVICE_SYNC_KEY,
              options: {
                global: "Use global setting",
                on: "Force on (this device)",
                off: "Force off (this device)",
              },
            },
          },
          {
            name: "Auto-sync debounce (ms)",
            control: {
              type: "number",
              key: "autoSyncDebounceMs",
              min: 100,
              validate: (v) => (v >= 100 ? undefined : "Must be 100 or more."),
            },
          },
          {
            name: "Backup XML before overwriting",
            control: { type: "toggle", key: "backupEnabled" },
          },
          {
            name: "Trim description whitespace on note write",
            desc: "Enabled by default for cleaner notes. Disable if you need XML → Markdown → XML round-trips to preserve description edge whitespace more exactly.",
            control: { type: "toggle", key: "trimDescriptionOnWrite" },
          },
        ],
      },
      {
        type: "group",
        heading: "Multi-device sync (advanced)",
        items: [
          {
            name: "About multi-device sync",
            desc: "These guard against data loss when the vault is synced across devices (Nextcloud, iCloud, Remotely Save). Defaults are right for most users.",
            searchable: false,
          },
          {
            name: "Backup folder",
            desc: `Vault-relative folder for MD snapshot backups (wipe-and-reimport). Empty = default to <event notes folder>/_backups, currently "${resolveBackupFolder(s)}". Existing backups at a previous path won't be moved automatically.`,
            control: {
              type: "text",
              key: "backupFolder",
              placeholder: `${s.eventNotesDir}/_backups`,
            },
          },
          {
            name: "Log folder",
            desc: `Vault-relative folder for the sync log file (timeline-sync.log). Empty = default to <event notes folder>/_logs, currently "${resolveLogFolder(s)}".`,
            control: {
              type: "text",
              key: "logFolder",
              placeholder: `${s.eventNotesDir}/_logs`,
            },
          },
          {
            name: "Backup retention (count)",
            desc: "Keep this many of each backup type: XML .bak-* siblings AND the backup folder's <label>-* subfolders. Older backups are trashed after each new one is created.",
            control: {
              type: "number",
              key: "backupRetention",
              min: 1,
              validate: (v) => (v >= 1 ? undefined : "Must be 1 or more."),
            },
          },
          {
            name: "Prune backups now",
            desc: "One-shot cleanup for piled-up backups from before retention was enforced.",
            action: () => void this.pruneBackups(),
          },
          {
            name: "Startup grace period (ms)",
            desc: "Auto-sync is suppressed for this long after the plugin loads. Lets remote sync finish its initial pull before we start writing. Default 30000.",
            control: {
              type: "number",
              key: "autoSyncStartupDelayMs",
              min: 0,
              validate: (v) => (v >= 0 ? undefined : "Must be 0 or more."),
            },
          },
          {
            name: "Self-write suppression TTL (ms)",
            desc: "How long after the plugin writes a file we ignore vault events for that file. Raise if remote sync lands plugin-written files later than this. Default 5000.",
            control: {
              type: "number",
              key: "selfWriteTtlMs",
              min: 500,
              validate: (v) => (v >= 500 ? undefined : "Must be 500 or more."),
            },
          },
          {
            name: "Sync log enabled",
            desc: `Append events (import-skipped, regen-aborted, filter-persist-failed, external-xml-change, wipe-backup, meta-stale-skip) to ${resolveLogFolder(s)}/timeline-sync.log. Rotated at ~200 KB.`,
            control: { type: "toggle", key: "syncLogEnabled" },
          },
          {
            name: "Log level",
            control: {
              type: "dropdown",
              key: "logLevel",
              options: {
                error: "Error",
                warn: "Warn",
                info: "Info",
                debug: "Debug",
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Diagnostics",
        items: [
          {
            name: "Recent diagnostics",
            render: (setting) => {
              const pre = setting.controlEl.createEl("pre", {
                cls: "txs-diagnostics-box",
              });
              pre.textContent = this.plugin.diagnostics.length
                ? this.plugin.diagnostics.join("\n")
                : "(no diagnostics)";
            },
          },
        ],
      },
    ];
  }

  /** Reads the value behind a control key. Called on every render. */
  getControlValue(key: string): unknown {
    if (key === DEVICE_SYNC_KEY) return getDeviceSyncMode();

    const s = this.plugin.settings;
    if (key === "hiddenCategories") return s.hiddenCategories.join(",");
    if (key === "renderDefaults.show") return s.renderDefaults.show.join(",");
    return readPath(s as unknown as Record<string, unknown>, key);
  }

  /** Persists a changed control. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;

    if (key === DEVICE_SYNC_KEY) {
      setDeviceSyncMode(String(value) as DeviceSyncMode);
      return;
    }

    // Mirror property names change the note schema, so they route through the
    // plugin's reimport prompt rather than a plain save.
    if (key.startsWith("mirrorNames.")) {
      const field = key.slice("mirrorNames.".length) as MirrorField;
      const next = String(value).trim() || DEFAULT_MIRROR_NAMES[field];
      if (next === s.mirrorNames[field]) return;
      await this.plugin.applySchemaAffectingChange(() => {
        s.mirrorNames[field] = next;
      });
      return;
    }

    if (key === "hiddenCategories") {
      s.hiddenCategories = splitList(value);
    } else if (key === "renderDefaults.show") {
      s.renderDefaults.show = splitList(value) as typeof s.renderDefaults.show;
    } else if (key === "timelineId") {
      s.timelineId = String(value).trim() || "main";
    } else {
      writePath(
        s as unknown as Record<string, unknown>,
        key,
        typeof value === "string" ? value.trim() : value
      );
    }

    await this.plugin.saveSettings();
  }

  /** Intro blurb with links to the desktop app and the plugin repo. */
  private introFragment(): DocumentFragment {
    const frag = createFragment();
    frag.appendText("Needs a .timeline save file from ");
    linkTo(frag, "Timeline Project", "http://thetimelineproj.sourceforge.net/");
    frag.appendText(" (free desktop app). Docs: ");
    linkTo(
      frag,
      "thetimelineproj.sourceforge.net/docs",
      "https://thetimelineproj.sourceforge.net/docs/contents.html"
    );
    frag.appendText(". Plugin source / issues: ");
    linkTo(
      frag,
      "github.com/davadev/obsidian_timeline",
      "https://github.com/davadev/obsidian_timeline"
    );
    frag.appendText(".");
    return frag;
  }

  /**
   * One row per known category: swatch, native color picker, free-text color,
   * and a button that drops the override. Custom DOM, so these are `render`
   * definitions rather than `control` ones.
   */
  private categoryColorItems(): SettingDefinition[] {
    const s = this.plugin.settings;
    const names = Array.from(
      new Set<string>([...s.knownCategories, ...Object.keys(s.categoryColors)])
    ).sort();

    if (!names.length) {
      return [
        {
          name: "No categories yet",
          desc: "Run the import command to populate this list.",
          searchable: false,
        },
      ];
    }

    return names.map((name) => ({
      name,
      render: (setting) => {
        const swatch = createSpan({ cls: "txs-category-swatch" });
        swatch.style.background =
          s.categoryColors[name] ?? "var(--background-secondary)";
        setting.nameEl.prepend(swatch);

        // Track the text input so the color picker can keep them in sync.
        let textComponent: { setValue: (v: string) => void } | null = null;

        // Native color picker — `<input type=color>` only understands
        // #rrggbb, so we normalise from rgb(...) / hsl(...) when seeding.
        const picker = createEl("input");
        picker.type = "color";
        picker.value = toHexColor(s.categoryColors[name] ?? "#888888");
        picker.addClass("txs-category-picker");
        picker.addEventListener("input", () => {
          s.categoryColors[name] = picker.value;
          swatch.style.background = picker.value;
          textComponent?.setValue(picker.value);
          void this.plugin.saveSettings();
        });
        setting.controlEl.prepend(picker);

        setting.addText((t) => {
          textComponent = t;
          return t
            .setPlaceholder("Hex or rgb(…)")
            .setValue(s.categoryColors[name] ?? "")
            .onChange((v) => {
              const val = v.trim();
              if (val) s.categoryColors[name] = val;
              else delete s.categoryColors[name];
              swatch.style.background =
                s.categoryColors[name] ?? "var(--background-secondary)";
              picker.value = toHexColor(s.categoryColors[name] ?? "#888888");
              void this.plugin.saveSettings();
            });
        });

        setting.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove color override")
            .onClick(() => {
              delete s.categoryColors[name];
              void this.plugin.saveSettings();
              this.update();
            })
        );
      },
    }));
  }

  private async pruneBackups(): Promise<void> {
    const s = this.plugin.settings;
    const xml = s.sourceXmlPath
      ? await this.plugin
          .runVaultPrune("xml", s.sourceXmlPath, s.backupRetention)
          .catch(() => 0)
      : 0;
    const wipe = await this.plugin
      .runVaultPrune("folder", "wipe", s.backupRetention)
      .catch(() => 0);
    new Notice(`Pruned ${xml} XML backup(s) and ${wipe} MD backup folder(s).`);
  }
}

type MirrorField = keyof typeof DEFAULT_MIRROR_NAMES;

const MIRROR_FIELDS: MirrorField[] = [
  "start",
  "end",
  "category",
  "eventId",
  "render",
  "role",
];

/** Reserved control key — this one lives in device storage, not settings. */
const DEVICE_SYNC_KEY = "device.syncMode";

function linkTo(frag: DocumentFragment, text: string, href: string): void {
  const a = frag.createEl("a", { text, href });
  a.setAttr("target", "_blank");
}

function splitList(value: unknown): string[] {
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Reads `a.b.c` out of the settings object. */
function readPath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Writes `a.b.c` into the settings object; no-ops on a missing parent. */
function writePath(
  root: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  const last = parts.pop();
  if (!last) return;
  let cur: Record<string, unknown> = root;
  for (const part of parts) {
    const next = cur[part];
    if (next == null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  cur[last] = value;
}
