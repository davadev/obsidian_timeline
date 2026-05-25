import { PluginSettingTab, Setting, type App } from "obsidian";
import type TimelineXmlSyncPlugin from "./main";
import { DEFAULT_MIRROR_NAMES } from "./timeline/model";
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    const help = containerEl.createDiv({ cls: "setting-item-description" });
    help.appendText("Needs a .timeline save file from ");
    help.createEl("a", {
      text: "Timeline Project",
      href: "http://thetimelineproj.sourceforge.net/",
    }).setAttr("target", "_blank");
    help.appendText(" (free desktop app). Docs: ");
    help.createEl("a", {
      text: "thetimelineproj.sourceforge.net/docs",
      href: "https://thetimelineproj.sourceforge.net/docs/contents.html",
    }).setAttr("target", "_blank");
    help.appendText(". Plugin source / issues: ");
    help.createEl("a", {
      text: "github.com/davadev/obsidian_timeline",
      href: "https://github.com/davadev/obsidian_timeline",
    }).setAttr("target", "_blank");
    help.appendText(".");

    containerEl.createEl("h2", { text: "Paths" });

    new Setting(containerEl)
      .setName("XML save file path")
      .setDesc("Vault-relative path to the .timeline file.")
      .addText((t) =>
        t
          .setPlaceholder("timelines/main.timeline")
          .setValue(s.sourceXmlPath)
          .onChange(async (v) => {
            s.sourceXmlPath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Event notes directory")
      .setDesc("Folder for one-Markdown-file-per-event.")
      .addText((t) =>
        t
          .setValue(s.eventNotesDir)
          .onChange(async (v) => {
            s.eventNotesDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Templates directory")
      .setDesc("Where the plugin writes its event-note template.")
      .addText((t) =>
        t
          .setValue(s.templatesDir)
          .onChange(async (v) => {
            s.templatesDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Timeline id")
      .setDesc("Logical id stored in each event's frontmatter (timeline.id).")
      .addText((t) =>
        t
          .setValue(s.timelineId)
          .onChange(async (v) => {
            s.timelineId = v.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Actions" });

    new Setting(containerEl)
      .setName("Import XML → Markdown")
      .addButton((b) =>
        b.setButtonText("Import").onClick(() => this.plugin.runCommand("txs-import"))
      );

    new Setting(containerEl)
      .setName("Force regenerate XML from Markdown")
      .addButton((b) =>
        b
          .setButtonText("Regenerate")
          .setWarning()
          .onClick(() => this.plugin.runCommand("txs-regenerate"))
      );

    new Setting(containerEl)
      .setName("Validate all event notes")
      .addButton((b) =>
        b.setButtonText("Validate").onClick(() => this.plugin.runCommand("txs-validate"))
      );

    new Setting(containerEl)
      .setName("New timeline event")
      .setDesc(
        "Recommended path. Prompts for a title, creates the note in the event notes folder, opens it, and reveals the Timeline inspector so you can fill in dates / category / description right away."
      )
      .addButton((b) =>
        b
          .setButtonText("New event")
          .setCta()
          .onClick(() => this.plugin.runCommand("txs-create-event"))
      );

    new Setting(containerEl)
      .setName("Create/Update Obsidian Templates plugin file (advanced)")
      .setDesc(
        "Writes a template that the core Templates plugin can insert. Deprecated for normal use — prefer the New event button above."
      )
      .addButton((b) =>
        b
          .setButtonText("Write template")
          .onClick(() => this.plugin.runCommand("txs-create-template"))
      );

    new Setting(containerEl)
      .setName("Auto-detect event notes (scan vault)")
      .setDesc(
        "Walks the vault for notes with timeline.enabled: true and points the plugin at the longest common parent folder. Useful first-run action on mobile."
      )
      .addButton((b) =>
        b
          .setButtonText("Detect")
          .onClick(() => this.plugin.runCommand("txs-auto-detect"))
      );

    new Setting(containerEl)
      .setName("Event source for rendering")
      .setDesc(
        "auto: prefer XML when present, fall back to Markdown scan. xml: always read the .timeline XML. md: always build events from Markdown notes (mobile-friendly when XML is not synced)."
      )
      .addDropdown((d) =>
        d
          .addOption("auto", "auto")
          .addOption("xml", "xml")
          .addOption("md", "md")
          .setValue(s.eventSource)
          .onChange(async (v) => {
            s.eventSource = v as typeof s.eventSource;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Wipe event notes and reimport from XML")
      .setDesc(
        "Use after a plugin upgrade that changed the event-note schema. Backs up the XML, deletes every .md in the event notes directory, then reimports."
      )
      .addButton((b) =>
        b
          .setButtonText("Wipe + reimport")
          .setWarning()
          .onClick(() => this.plugin.runCommand("txs-wipe-reimport"))
      );

    containerEl.createEl("h2", { text: "Mirror property names" });
    const mirrorFields: (keyof typeof DEFAULT_MIRROR_NAMES)[] = [
      "start",
      "end",
      "category",
      "eventId",
      "render",
      "role",
    ];
    for (const key of mirrorFields) {
      new Setting(containerEl)
        .setName(`timeline.${key}`)
        .setDesc("Schema-affecting — changing this will offer a reimport.")
        .addText((t) =>
          t
            .setValue(s.mirrorNames[key])
            .onChange((v) => {
              const next = v.trim() || DEFAULT_MIRROR_NAMES[key];
              if (next === s.mirrorNames[key]) return;
              void this.plugin.applySchemaAffectingChange(() => {
                s.mirrorNames[key] = next;
              });
            })
        );
    }

    containerEl.createEl("h2", { text: "Render defaults" });

    new Setting(containerEl)
      .setName("Default render mode")
      .addDropdown((d) =>
        d
          .addOption("bar", "bar")
          .addOption("list", "list")
          .addOption("hybrid", "hybrid")
          .setValue(s.renderDefaults.mode)
          .onChange(async (v) => {
            s.renderDefaults.mode = v as typeof s.renderDefaults.mode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default details style")
      .addDropdown((d) =>
        d
          .addOption("list", "list")
          .addOption("compact", "compact")
          .addOption("table", "table")
          .addOption("cards", "cards")
          .setValue(s.renderDefaults.details)
          .onChange(async (v) => {
            s.renderDefaults.details = v as typeof s.renderDefaults.details;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default sort order")
      .addDropdown((d) =>
        d
          .addOption("chronological", "chronological")
          .addOption("reverse-chronological", "reverse-chronological")
          .addOption("category", "category")
          .setValue(s.renderDefaults.sort)
          .onChange(async (v) => {
            s.renderDefaults.sort = v as typeof s.renderDefaults.sort;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Click behavior in rendered timelines")
      .setDesc(
        "What happens when you tap an event in a render block or the Timeline view."
      )
      .addDropdown((d) =>
        d
          .addOption("inspector", "Open in Timeline inspector (right sidebar)")
          .addOption("open-note", "Open the underlying note")
          .setValue(s.clickBehavior)
          .onChange(async (v) => {
            s.clickBehavior = v as typeof s.clickBehavior;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default zoom factor")
      .setDesc(
        "Multiplier for the time axis. 1 = fits container, 4 = 4× wider (horizontal scroll). Per-block `zoom: N` overrides this."
      )
      .addText((t) =>
        t
          .setValue(String(s.renderDefaults.zoom))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (Number.isFinite(n) && n > 0) {
              s.renderDefaults.zoom = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Years of context for single-point notes")
      .setDesc(
        "When a viewer note's start = end, the viewport is padded by this many years on each side so neighbouring range events are visible. Per-block override: pointPaddingYears: <n>."
      )
      .addText((t) =>
        t.setValue(String(s.pointPaddingYears)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 0) {
            s.pointPaddingYears = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Show in-render filter bar by default")
      .setDesc(
        "Toggle the category chip bar that appears above each rendered timeline. Per-block override: showFilterUI: false."
      )
      .addToggle((t) =>
        t.setValue(s.renderDefaults.showFilterUI).onChange(async (v) => {
          s.renderDefaults.showFilterUI = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Global view date filter precision")
      .setDesc(
        "How many date components the filter row in the Timeline view exposes. Year keeps things compact; Day or Time adds the extra inputs."
      )
      .addDropdown((d) =>
        d
          .addOption("year", "Year only (default)")
          .addOption("day", "Year + month + day")
          .addOption("time", "Year + month + day + time")
          .setValue(s.globalFilterPrecision)
          .onChange(async (v) => {
            s.globalFilterPrecision = v as typeof s.globalFilterPrecision;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Globally hidden categories")
      .setDesc(
        "Comma-separated list. Hidden by default in every render; the in-render chip bar can re-enable per timeline."
      )
      .addText((t) =>
        t
          .setValue(s.hiddenCategories.join(","))
          .onChange(async (v) => {
            s.hiddenCategories = v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default orientation")
      .addDropdown((d) =>
        d
          .addOption("horizontal", "horizontal")
          .addOption("vertical", "vertical")
          .setValue(s.renderDefaults.orientation)
          .onChange(async (v) => {
            s.renderDefaults.orientation = v as typeof s.renderDefaults.orientation;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default fields shown")
      .setDesc("Comma-separated: title,date,category,description,tags,links,source")
      .addText((t) =>
        t
          .setValue(s.renderDefaults.show.join(","))
          .onChange(async (v) => {
            s.renderDefaults.show = v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean) as typeof s.renderDefaults.show;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Category colors" });
    containerEl.createEl("div", {
      text:
        "Categories discovered on import are listed here. Colors mirror the XML by default; edit to override. Use a CSS color (e.g. #88bb55 or rgb(120,180,90)).",
      cls: "setting-item-description",
    });
    const colorsBox = containerEl.createDiv();
    const renderColors = () => {
      colorsBox.empty();
      const all = new Set<string>([
        ...s.knownCategories,
        ...Object.keys(s.categoryColors),
      ]);
      const names = Array.from(all).sort();
      if (!names.length) {
        colorsBox.createDiv({
          text: "(no categories yet — run the Import command to populate)",
        });
      }
      for (const name of names) {
        const swatch = document.createElement("span");
        swatch.style.display = "inline-block";
        swatch.style.width = "16px";
        swatch.style.height = "16px";
        swatch.style.marginRight = "8px";
        swatch.style.verticalAlign = "middle";
        swatch.style.border = "1px solid var(--background-modifier-border)";
        swatch.style.borderRadius = "3px";
        swatch.style.background =
          s.categoryColors[name] ?? "var(--background-secondary)";
        const setting = new Setting(colorsBox).setName(name);
        setting.nameEl.prepend(swatch);

        // Track the text input so the color picker can keep them in sync.
        let textComponent: { setValue: (v: string) => void } | null = null;

        // Native color picker — `<input type=color>` only understands
        // #rrggbb, so we normalise from rgb(...) / hsl(...) when seeding.
        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = toHexColor(s.categoryColors[name] ?? "#888888");
        picker.style.marginRight = "6px";
        picker.addEventListener("input", async () => {
          s.categoryColors[name] = picker.value;
          swatch.style.background = picker.value;
          textComponent?.setValue(picker.value);
          await this.plugin.saveSettings();
        });
        setting.controlEl.prepend(picker);

        setting.addText((t) => {
          textComponent = t;
          return t
            .setPlaceholder("#aabbcc or rgb(…)")
            .setValue(s.categoryColors[name] ?? "")
            .onChange(async (v) => {
              const val = v.trim();
              if (val) s.categoryColors[name] = val;
              else delete s.categoryColors[name];
              swatch.style.background =
                s.categoryColors[name] ?? "var(--background-secondary)";
              picker.value = toHexColor(s.categoryColors[name] ?? "#888888");
              await this.plugin.saveSettings();
            });
        });
        setting.addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("Remove color override")
            .onClick(async () => {
              delete s.categoryColors[name];
              await this.plugin.saveSettings();
              renderColors();
            })
        );
      }
    };
    renderColors();

    containerEl.createEl("h2", { text: "Sync & backup" });

    new Setting(containerEl)
      .setName("Auto-sync Markdown → XML (global)")
      .setDesc(
        "Vault-wide default. The per-device override below can force this on or off for the current device only."
      )
      .addToggle((t) =>
        t.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-sync on this device")
      .setDesc(
        "Stored in this device's local storage — does NOT sync with the vault. Use 'Off' on phones if only the desktop should write the .timeline file."
      )
      .addDropdown((d) =>
        d
          .addOption("global", "Use global setting")
          .addOption("on", "Force on (this device)")
          .addOption("off", "Force off (this device)")
          .setValue(getDeviceSyncMode())
          .onChange((v) => setDeviceSyncMode(v as DeviceSyncMode))
      );

    new Setting(containerEl)
      .setName("Auto-sync debounce (ms)")
      .addText((t) =>
        t.setValue(String(s.autoSyncDebounceMs)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n >= 100) {
            s.autoSyncDebounceMs = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Backup XML before overwriting")
      .addToggle((t) =>
        t.setValue(s.backupEnabled).onChange(async (v) => {
          s.backupEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Log level")
      .addDropdown((d) =>
        d
          .addOption("error", "error")
          .addOption("warn", "warn")
          .addOption("info", "info")
          .addOption("debug", "debug")
          .setValue(s.logLevel)
          .onChange(async (v) => {
            s.logLevel = v as typeof s.logLevel;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Diagnostics" });
    const diagBox = containerEl.createEl("pre");
    diagBox.style.maxHeight = "200px";
    diagBox.style.overflow = "auto";
    diagBox.textContent = this.plugin.diagnostics.length
      ? this.plugin.diagnostics.join("\n")
      : "(no diagnostics)";
  }
}
