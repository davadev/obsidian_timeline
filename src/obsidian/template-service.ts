import { Modal, Notice, Setting, normalizePath, type App } from "obsidian";
import type { VaultAdapter } from "./vault-adapter";
import { slugify } from "../timeline/id-utils";
import { renderEventMarkdown } from "../timeline/markdown-writer";
import type { TimelineEvent } from "../timeline/model";

const TEMPLATE_FILENAME = "Timeline Event.md";

export interface CreatedEvent {
  /** Vault-relative path of the new note. */
  path: string;
  /** The synthesized event id (matches `timeline.event_id` in frontmatter). */
  eventId: string;
}

/**
 * Builds an Obsidian-Templates-compatible template (uses {{title}}, {{date}},
 * {{time}} placeholders) and a "create new event" command that works even when
 * the core Templates plugin is disabled.
 */
export class TemplateService {
  constructor(
    private app: App,
    private vault: VaultAdapter,
    private getSettings: () => {
      templatesDir: string;
      eventNotesDir: string;
      timelineId: string;
      sourceXmlPath: string;
    }
  ) {}

  templatePath(): string {
    const { templatesDir } = this.getSettings();
    return normalizePath(`${templatesDir}/${TEMPLATE_FILENAME}`);
  }

  async createOrUpdateTemplate(): Promise<string> {
    const { templatesDir } = this.getSettings();
    if (!templatesDir) {
      throw new Error(
        "Templates directory not configured. Set it in plugin settings first."
      );
    }
    await this.vault.ensureFolder(templatesDir);
    const path = this.templatePath();
    const content = TEMPLATE_BODY(this.getSettings());
    await this.vault.writeText(path, content);
    return path;
  }

  /** Create a new event note even without the core Templates plugin. */
  async createNewEventNote(title: string): Promise<CreatedEvent> {
    const { eventNotesDir, sourceXmlPath, timelineId } = this.getSettings();
    if (!eventNotesDir) {
      throw new Error("Event notes directory not configured.");
    }
    await this.vault.ensureFolder(eventNotesDir);
    const stamp = new Date()
      .toISOString()
      .replace("T", "-")
      .replace(/[:.Z]/g, "")
      .slice(0, 15);
    const id = `${slugify(title)}-${stamp}`;
    const skeleton: TimelineEvent = {
      id,
      text: title || "New event",
      start: { year: new Date().getUTCFullYear(), month: 1, day: 1 },
      end: { year: new Date().getUTCFullYear(), month: 1, day: 1 },
      isPoint: true,
      category: "Uncategorized",
    };
    const md = renderEventMarkdown(skeleton, {
      sourceXmlPath,
      timelineId,
    });
    const filename = `${slugify(title) || "new-event"}.md`;
    const path = normalizePath(`${eventNotesDir}/${filename}`);
    await this.vault.writeText(path, md);
    return { path, eventId: id };
  }

  /**
   * Modal-driven flow: prompt for title, create the note in the configured
   * event directory, then open it and reveal the Timeline inspector with the
   * fresh event loaded. Skips the modal when `title` is provided.
   */
  async createNewEventInteractive(
    openNote: (path: string) => Promise<void>,
    openInspector: (eventId: string, path: string) => Promise<void>,
    title?: string
  ): Promise<void> {
    const finalTitle = title ?? (await promptForTitle(this.app));
    if (finalTitle == null) return; // user cancelled
    const { path, eventId } = await this.createNewEventNote(finalTitle);
    new Notice(`Created ${path}`);
    await openNote(path);
    await openInspector(eventId, path);
  }

  /**
   * Modal-driven flow to add an era. Prompts the user for the basics, writes
   * the era's Markdown note into `_eras/<id>.md`, then loads it in the
   * Timeline inspector for further tuning.
   */
  async createNewEraInteractive(
    vault: VaultAdapter,
    openEraInInspector: (eraId: string) => Promise<void>
  ): Promise<void> {
    const result = await promptForEra(this.app);
    if (!result) return;
    const { name, start, end, color } = result;
    const { eventNotesDir, sourceXmlPath, timelineId } = this.getSettings();
    const erasDir = `${eventNotesDir}/_eras`;
    await vault.ensureFolder(erasDir);
    const baseId = slugify(name || "era");
    const stamp = new Date()
      .toISOString()
      .replace("T", "-")
      .replace(/[:.Z]/g, "")
      .slice(0, 15);
    const id = `${baseId}-${stamp}`;
    const { renderEraMarkdown } = await import("../timeline/era-md");
    const md = renderEraMarkdown(
      { id, name, start, end, color: color || undefined },
      timelineId,
      sourceXmlPath
    );
    const path = normalizePath(`${erasDir}/${id}.md`);
    await vault.writeText(path, md);
    new Notice(`Created era ${name}`);
    await openEraInInspector(id);
  }
}

interface EraPromptResult {
  name: string;
  start: { year: number; month?: number; day?: number };
  end: { year: number; month?: number; day?: number };
  color: string;
}

function promptForEra(app: App): Promise<EraPromptResult | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText("New era");
    const wrap = modal.contentEl.createDiv();

    let name = "";
    let startY = "";
    let startM = "";
    let startD = "";
    let endY = "";
    let endM = "";
    let endD = "";
    let color = "";
    let resolved = false;

    new Setting(wrap).setName("Name").addText((t) => {
      t.setPlaceholder("e.g. Bronze Age");
      t.inputEl.style.width = "100%";
      t.onChange((v) => (name = v));
      setTimeout(() => t.inputEl.focus(), 0);
    });

    const startBox = wrap.createDiv();
    startBox.createEl("div", { text: "Start (year required; month/day optional)" });
    const startRow = startBox.createDiv();
    startRow.style.display = "flex";
    startRow.style.gap = "6px";
    const sy = startRow.createEl("input", { type: "number", placeholder: "year" }) as HTMLInputElement;
    const sm = startRow.createEl("input", { type: "number", placeholder: "mm" }) as HTMLInputElement;
    const sd = startRow.createEl("input", { type: "number", placeholder: "dd" }) as HTMLInputElement;
    sm.style.width = "60px";
    sd.style.width = "60px";
    sy.addEventListener("input", () => (startY = sy.value));
    sm.addEventListener("input", () => (startM = sm.value));
    sd.addEventListener("input", () => (startD = sd.value));

    const endBox = wrap.createDiv();
    endBox.createEl("div", { text: "End (year required)" });
    const endRow = endBox.createDiv();
    endRow.style.display = "flex";
    endRow.style.gap = "6px";
    const ey = endRow.createEl("input", { type: "number", placeholder: "year" }) as HTMLInputElement;
    const em = endRow.createEl("input", { type: "number", placeholder: "mm" }) as HTMLInputElement;
    const ed = endRow.createEl("input", { type: "number", placeholder: "dd" }) as HTMLInputElement;
    em.style.width = "60px";
    ed.style.width = "60px";
    ey.addEventListener("input", () => (endY = ey.value));
    em.addEventListener("input", () => (endM = em.value));
    ed.addEventListener("input", () => (endD = ed.value));

    new Setting(wrap).setName("Color (optional)").addText((t) => {
      t.setPlaceholder("r,g,b or #hex");
      t.inputEl.style.width = "100%";
      t.onChange((v) => (color = v));
    });

    const actions = wrap.createDiv({ cls: "modal-button-container" });
    actions.style.marginTop = "12px";
    const create = actions.createEl("button", { cls: "mod-cta", text: "Create" });
    create.addEventListener("click", () => {
      const yStart = parseInt(startY, 10);
      const yEnd = parseInt(endY, 10);
      if (!name.trim() || !Number.isFinite(yStart) || !Number.isFinite(yEnd)) {
        new Notice("Name + start year + end year are required.");
        return;
      }
      const intOr = (v: string): number | undefined => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : undefined;
      };
      resolved = true;
      resolve({
        name: name.trim(),
        start: { year: yStart, month: intOr(startM), day: intOr(startD) },
        end: { year: yEnd, month: intOr(endM), day: intOr(endD) },
        color: color.trim(),
      });
      modal.close();
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.style.marginLeft = "6px";
    cancel.addEventListener("click", () => modal.close());

    modal.onClose = () => {
      if (!resolved) resolve(null);
    };
    modal.open();
  });
}

function promptForTitle(app: App): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText("New timeline event");
    const wrap = modal.contentEl.createDiv();
    let value = "";
    let resolved = false;
    new Setting(wrap)
      .setName("Title")
      .addText((t) => {
        t.setPlaceholder("e.g. Hezekiah (770 B.C.E. - 716 B.C.E.)");
        t.inputEl.style.width = "100%";
        t.onChange((v) => (value = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && value.trim()) {
            resolved = true;
            resolve(value.trim());
            modal.close();
          }
        });
        // Focus once the modal is mounted.
        setTimeout(() => t.inputEl.focus(), 0);
      });
    const actions = wrap.createDiv({ cls: "modal-button-container" });
    actions.style.marginTop = "12px";
    const create = actions.createEl("button", { cls: "mod-cta", text: "Create" });
    create.addEventListener("click", () => {
      if (!value.trim()) return;
      resolved = true;
      resolve(value.trim());
      modal.close();
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.style.marginLeft = "6px";
    cancel.addEventListener("click", () => modal.close());
    modal.onClose = () => {
      if (!resolved) resolve(null);
    };
    modal.open();
  });
}

const TEMPLATE_BODY = (cfg: {
  sourceXmlPath: string;
  timelineId: string;
}) => `---
title: "{{title}}"
tags:
  - Timeline

timeline:
  enabled: true
  id: ${cfg.timelineId}
  event_id: "{{date}}-{{time}}"
  role: event
  source_xml: ${cfg.sourceXmlPath}
  category: Uncategorized
  render: true
  ends_today: false
  hyperlink: null
  start:
    year:
    month:
    day:
    hour: 0
    minute: 0
    second: 0
  end:
    year:
    month:
    day:
    hour: 0
    minute: 0
    second: 0

timeline_start:
timeline_end:
timeline_category: Uncategorized
timeline_event_id: "{{date}}-{{time}}"
timeline_render: true
timeline_role: event
---

# {{title}}

## Text

## Description

## Timeline

\`\`\`timeline
mode: hybrid
source: main
\`\`\`
`;
