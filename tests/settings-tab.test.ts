// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import { Notice, Setting } from "../testUtils/obsidian";
import { TimelineXmlSyncSettingTab } from "../src/settings-tab";
import { DEFAULT_SETTINGS, type TimelineXmlSyncSettings } from "../src/settings";
import { initDeviceStore } from "../src/obsidian/app-storage";
import { FakeApp } from "../testUtils/fake-app";

type Plugin = {
  settings: TimelineXmlSyncSettings;
  diagnostics: string[];
  runCommand: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  applySchemaAffectingChange: ReturnType<typeof vi.fn>;
  runVaultPrune: ReturnType<typeof vi.fn>;
};

let plugin: Plugin;
let tab: TimelineXmlSyncSettingTab;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

beforeEach(() => {
  Notice.reset();
  Setting.instances.length = 0;
  initDeviceStore(new FakeApp() as never);
  plugin = {
    settings: clone(DEFAULT_SETTINGS),
    diagnostics: [],
    runCommand: vi.fn(),
    saveSettings: vi.fn(async () => {}),
    applySchemaAffectingChange: vi.fn(async (mutate: () => void) => mutate()),
    runVaultPrune: vi.fn(async () => 2),
  };
  tab = new TimelineXmlSyncSettingTab(new FakeApp() as never, plugin as never);
});

/** Every row of a (possibly grouped) definition list, flattened. */
const flatten = (items: SettingDefinitionItem[]): SettingDefinition[] =>
  items.flatMap((i) => ("items" in i ? flatten(i.items as SettingDefinitionItem[]) : [i as SettingDefinition]));
const rows = () => flatten(tab.getSettingDefinitions());
const row = (name: string) => rows().find((r) => r.name === name)!;
type Control = { key: string; type: string; validate?: (v: number) => string | undefined };
const controls = () => rows().filter((r) => "control" in r && r.control).map((r) => (r as unknown as { control: Control }).control);

describe("definitions", () => {
  it("has a heading group for each area", () => {
    const groups = tab.getSettingDefinitions().filter((i) => "heading" in i).map((i) => (i as { heading: string }).heading);
    expect(groups).toEqual(["Paths", "Actions", "Mirror property names", "Render defaults", "Category colors", "Sync & backup", "Multi-device sync (advanced)", "Diagnostics"]);
  });

  it("backs every control with a real, readable setting", () => {
    for (const c of controls()) {
      if (c.key === "device.syncMode") continue;
      expect(tab.getControlValue(c.key), c.key).not.toBeUndefined();
    }
  });

  it("round-trips every control: what is written is what is read", async () => {
    for (const c of controls()) {
      if (c.key === "device.syncMode" || c.key.startsWith("mirrorNames.")) continue;
      const before = tab.getControlValue(c.key);
      await tab.setControlValue(c.key, before);
      expect(tab.getControlValue(c.key), c.key).toEqual(before);
    }
  });

  it("wires each action button to its command", () => {
    const actions: Array<[string, string]> = [
      ["Import XML → Markdown", "txs-import"],
      ["Force regenerate XML from Markdown", "txs-regenerate"],
      ["Validate all event notes", "txs-validate"],
      ["New timeline event", "txs-create-event"],
      ["Create/update Obsidian templates plugin file (advanced)", "txs-create-template"],
      ["Auto-detect event notes (scan vault)", "txs-auto-detect"],
      ["Wipe event notes and reimport from XML", "txs-wipe-reimport"],
    ];
    for (const [name, id] of actions) {
      (row(name) as unknown as { action: () => void }).action();
      expect(plugin.runCommand).toHaveBeenLastCalledWith(id);
    }
  });

  it("validates numeric controls", () => {
    const rule = (key: string) => controls().find((c) => c.key === key)!.validate!;
    expect([rule("renderDefaults.zoom")(1), rule("renderDefaults.zoom")(0)]).toEqual([undefined, "Must be greater than 0."]);
    expect([rule("pointPaddingYears")(0), rule("pointPaddingYears")(-1)]).toEqual([undefined, "Must be 0 or more."]);
    expect([rule("fuzzyGradientPercent")(20), rule("fuzzyGradientPercent")(0), rule("fuzzyGradientPercent")(50)]).toEqual([undefined, "Must be between 1 and 49.", "Must be between 1 and 49."]);
    expect([rule("autoSyncDebounceMs")(100), rule("autoSyncDebounceMs")(99)]).toEqual([undefined, "Must be 100 or more."]);
    expect([rule("backupRetention")(1), rule("backupRetention")(0)]).toEqual([undefined, "Must be 1 or more."]);
    expect([rule("autoSyncStartupDelayMs")(0), rule("autoSyncStartupDelayMs")(-1)]).toEqual([undefined, "Must be 0 or more."]);
    expect([rule("selfWriteTtlMs")(500), rule("selfWriteTtlMs")(499)]).toEqual([undefined, "Must be 500 or more."]);
  });

  it("describes the effective backup and log folders", () => {
    plugin.settings.backupFolder = "My/Backups";
    plugin.settings.logFolder = "";
    expect(row("Backup folder").desc).toContain('currently "My/Backups"');
    expect(row("Log folder").desc).toContain(`currently "${plugin.settings.eventNotesDir}/_logs"`);
    expect(row("Sync log enabled").desc).toContain("/_logs/timeline-sync.log");
  });

  it("builds the intro with links", () => {
    const frag = row("Timeline Project save file").desc as unknown as DocumentFragment;
    const links = [...frag.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("target"))).toEqual(["_blank", "_blank", "_blank"]);
    expect(links[0].getAttribute("href")).toContain("thetimelineproj");
    expect(frag.textContent).toContain("Needs a .timeline save file from");
  });
});

describe("reading and writing values", () => {
  it("reads nested keys, list-valued keys and the per-device mode", async () => {
    plugin.settings.hiddenCategories = ["a", "b"];
    plugin.settings.renderDefaults.show = ["title", "date"];
    expect(tab.getControlValue("hiddenCategories")).toBe("a,b");
    expect(tab.getControlValue("renderDefaults.show")).toBe("title,date");
    expect(tab.getControlValue("renderDefaults.mode")).toBe(plugin.settings.renderDefaults.mode);
    expect(tab.getControlValue("nope.deeper")).toBeUndefined();
    expect(tab.getControlValue("sourceXmlPath.deeper")).toBeUndefined();
    expect(tab.getControlValue("device.syncMode")).toBe("global");
    await tab.setControlValue("device.syncMode", "off");
    expect(tab.getControlValue("device.syncMode")).toBe("off");
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("splits comma lists, trims strings, and saves", async () => {
    await tab.setControlValue("hiddenCategories", " a, ,b ");
    expect(plugin.settings.hiddenCategories).toEqual(["a", "b"]);
    await tab.setControlValue("renderDefaults.show", "title, date");
    expect(plugin.settings.renderDefaults.show).toEqual(["title", "date"]);
    await tab.setControlValue("eventNotesDir", "  Notes ");
    expect(plugin.settings.eventNotesDir).toBe("Notes");
    await tab.setControlValue("autoSyncDebounceMs", 5000);
    expect(plugin.settings.autoSyncDebounceMs).toBe(5000);
    await tab.setControlValue("renderDefaults.stickyLabels", false);
    expect(plugin.settings.renderDefaults.stickyLabels).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(5);
  });

  it("keeps the timeline id non-empty", async () => {
    await tab.setControlValue("timelineId", "  custom ");
    expect(plugin.settings.timelineId).toBe("custom");
    await tab.setControlValue("timelineId", "   ");
    expect(plugin.settings.timelineId).toBe("main");
  });

  it("ignores a write under a missing parent object", async () => {
    await tab.setControlValue("nothing.here", 1);
    expect((plugin.settings as unknown as Record<string, unknown>).nothing).toBeUndefined();
    await tab.setControlValue("sourceXmlPath.deeper", 1);
    expect(plugin.settings.sourceXmlPath).toBe(DEFAULT_SETTINGS.sourceXmlPath);
    await tab.setControlValue("", 1);
  });

  it("routes mirror property names through the schema-change flow, falling back to defaults when blank", async () => {
    await tab.setControlValue("mirrorNames.start", "begin");
    expect(plugin.applySchemaAffectingChange).toHaveBeenCalledTimes(1);
    expect(plugin.settings.mirrorNames.start).toBe("begin");
    await tab.setControlValue("mirrorNames.start", "begin"); // unchanged
    expect(plugin.applySchemaAffectingChange).toHaveBeenCalledTimes(1);
    await tab.setControlValue("mirrorNames.start", "  ");
    expect(plugin.settings.mirrorNames.start).toBe("timeline_start");
  });
});

describe("category colours", () => {
  const renderRow = (name: string) => {
    const setting = new Setting(document.createElement("div"));
    (row(name) as unknown as { render: (s: Setting) => void }).render(setting);
    return setting;
  };

  it("says so when there are no categories yet", () => {
    expect(row("No categories yet").desc).toContain("Run the import command");
  });

  it("lists every known category once, sorted", () => {
    plugin.settings.knownCategories = ["War", "Peace"];
    plugin.settings.categoryColors = { War: "red", Extra: "blue" };
    const names = rows().map((r) => r.name).filter((n) => ["Peace", "War", "Extra"].includes(n as string));
    expect(names).toEqual(["Extra", "Peace", "War"]);
  });

  it("seeds a picker, swatch and text field from the stored colour", () => {
    plugin.settings.knownCategories = ["War"];
    plugin.settings.categoryColors = { War: "rgb(255, 0, 0)" };
    const s = renderRow("War");
    expect((s.nameEl.querySelector(".txs-category-swatch") as HTMLElement).style.background).toBe("rgb(255, 0, 0)");
    expect((s.controlEl.querySelector("input[type=color]") as HTMLInputElement).value).toBe("#ff0000");
    expect(s.text[0].getValue()).toBe("rgb(255, 0, 0)");
  });

  it("uses neutral defaults for a category with no colour", () => {
    plugin.settings.knownCategories = ["Peace"];
    const s = renderRow("Peace");
    expect((s.nameEl.querySelector(".txs-category-swatch") as HTMLElement).style.background).toBe("var(--background-secondary)");
    expect((s.controlEl.querySelector("input[type=color]") as HTMLInputElement).value).toBe("#888888");
  });

  it("the picker updates the colour, the swatch and the text, and saves", () => {
    plugin.settings.knownCategories = ["War"];
    const s = renderRow("War");
    const picker = s.controlEl.querySelector("input[type=color]") as HTMLInputElement;
    picker.value = "#00ff00";
    picker.dispatchEvent(new Event("input"));
    expect(plugin.settings.categoryColors.War).toBe("#00ff00");
    expect(s.text[0].getValue()).toBe("#00ff00");
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("typing a colour sets it, and clearing the field removes the override", async () => {
    plugin.settings.knownCategories = ["War"];
    const s = renderRow("War");
    const picker = s.controlEl.querySelector("input[type=color]") as HTMLInputElement;
    await s.text[0].type(" hsl(120, 100%, 50%) ");
    expect(plugin.settings.categoryColors.War).toBe("hsl(120, 100%, 50%)");
    expect(picker.value).toBe("#00ff00");
    await s.text[0].type("");
    expect(plugin.settings.categoryColors.War).toBeUndefined();
    expect(picker.value).toBe("#888888");
  });

  it("the trash button removes the override and refreshes the tab", async () => {
    plugin.settings.knownCategories = ["War"];
    plugin.settings.categoryColors = { War: "red" };
    const s = renderRow("War");
    expect(s.extraButtons[0]).toMatchObject({ icon: "trash", tooltip: "Remove color override" });
    await s.extraButtons[0].click();
    expect(plugin.settings.categoryColors.War).toBeUndefined();
    expect((tab as unknown as { updates: number }).updates).toBe(1);
  });

  it("understands every colour notation the picker can be seeded from", () => {
    const seeded = (color: string) => {
      plugin.settings.knownCategories = ["C"];
      plugin.settings.categoryColors = { C: color };
      return (renderRow("C").controlEl.querySelector("input[type=color]") as HTMLInputElement).value;
    };
    expect(seeded("#ABCDEF")).toBe("#abcdef");
    expect(seeded("#abc")).toBe("#aabbcc");
    expect(seeded("rgba(1, 2, 3, 0.5)")).toBe("#010203");
    expect(seeded("10,20,30")).toBe("#0a141e");
    expect(seeded("rgb(300, 0, 0)")).toBe("#ff0000");
    expect(seeded("hsla(240, 100%, 50%, 1)")).toBe("#0000ff");
    expect(seeded("hsl(0, 0%, 100%)")).toBe("#ffffff");
    expect(seeded("   ")).toBe("#888888");
    expect(seeded("chartreuse")).toBe("#888888");
  });
});

describe("diagnostics and pruning", () => {
  const diagnosticsText = () => {
    const setting = new Setting(document.createElement("div"));
    (row("Recent diagnostics") as unknown as { render: (s: Setting) => void }).render(setting);
    return setting.controlEl.querySelector("pre.txs-diagnostics-box")?.textContent;
  };

  it("shows stored diagnostics or a placeholder", () => {
    expect(diagnosticsText()).toBe("(no diagnostics)");
    plugin.diagnostics = ["a: bad", "b: worse"];
    expect(diagnosticsText()).toBe("a: bad\nb: worse");
  });

  it("prunes XML and folder backups and reports the counts", async () => {
    plugin.settings.sourceXmlPath = "t.timeline";
    plugin.settings.backupRetention = 3;
    await (row("Prune backups now") as unknown as { action: () => Promise<void> }).action();
    await vi.waitFor(() => expect(Notice.messages()).toEqual(["Pruned 2 XML backup(s) and 2 MD backup folder(s)."]));
    expect(plugin.runVaultPrune).toHaveBeenCalledWith("xml", "t.timeline", 3);
    expect(plugin.runVaultPrune).toHaveBeenCalledWith("folder", "wipe", 3);
  });

  it("skips the XML when none is configured, and counts a failed prune as zero", async () => {
    plugin.settings.sourceXmlPath = "";
    plugin.runVaultPrune.mockRejectedValue(new Error("nope"));
    await (row("Prune backups now") as unknown as { action: () => Promise<void> }).action();
    await vi.waitFor(() => expect(Notice.messages()).toEqual(["Pruned 0 XML backup(s) and 0 MD backup folder(s)."]));
    expect(plugin.runVaultPrune).toHaveBeenCalledTimes(1);
    plugin.settings.sourceXmlPath = "t.timeline";
    await (row("Prune backups now") as unknown as { action: () => Promise<void> }).action();
    await vi.waitFor(() => expect(Notice.messages()).toHaveLength(2));
  });
});
