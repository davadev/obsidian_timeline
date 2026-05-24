import { normalizePath, type App } from "obsidian";
import type { VaultAdapter } from "./vault-adapter";
import { slugify } from "../timeline/id-utils";
import { renderEventMarkdown } from "../timeline/markdown-writer";
import type { TimelineEvent } from "../timeline/model";

const TEMPLATE_FILENAME = "Timeline Event.md";

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
  async createNewEventNote(title: string): Promise<string> {
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
    return path;
  }
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
`;
