import { PluginSettingTab, Setting, type App } from "obsidian";
import type TimelineXmlSyncPlugin from "./main";
import { DEFAULT_MIRROR_NAMES } from "./timeline/model";

export class TimelineXmlSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TimelineXmlSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

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
      .setName("Create/Update event note template")
      .addButton((b) =>
        b.setButtonText("Write template").onClick(() =>
          this.plugin.runCommand("txs-create-template")
        )
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
        .addText((t) =>
          t
            .setValue(s.mirrorNames[key])
            .onChange(async (v) => {
              s.mirrorNames[key] = v.trim() || DEFAULT_MIRROR_NAMES[key];
              await this.plugin.saveSettings();
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
    const colorsBox = containerEl.createDiv();
    const renderColors = () => {
      colorsBox.empty();
      const names = Object.keys(s.categoryColors);
      if (!names.length) {
        colorsBox.createDiv({ text: "(no category colors configured)" });
      }
      for (const name of names) {
        new Setting(colorsBox)
          .setName(name)
          .addText((t) =>
            t.setValue(s.categoryColors[name]).onChange(async (v) => {
              s.categoryColors[name] = v.trim();
              await this.plugin.saveSettings();
            })
          )
          .addExtraButton((b) =>
            b
              .setIcon("trash")
              .setTooltip("Remove")
              .onClick(async () => {
                delete s.categoryColors[name];
                await this.plugin.saveSettings();
                renderColors();
              })
          );
      }
      const addRow = colorsBox.createDiv();
      addRow.style.display = "flex";
      addRow.style.gap = "6px";
      addRow.style.marginTop = "6px";
      const nameInput = addRow.createEl("input", { type: "text", placeholder: "category" });
      const colorInput = addRow.createEl("input", { type: "text", placeholder: "#aabbcc or r,g,b" });
      const addBtn = addRow.createEl("button", { text: "Add" });
      addBtn.addEventListener("click", async () => {
        const n = nameInput.value.trim();
        const c = colorInput.value.trim();
        if (n && c) {
          s.categoryColors[n] = c;
          await this.plugin.saveSettings();
          renderColors();
        }
      });
    };
    renderColors();

    containerEl.createEl("h2", { text: "Sync & backup" });

    new Setting(containerEl)
      .setName("Auto-sync Markdown → XML")
      .addToggle((t) =>
        t.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
        })
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
