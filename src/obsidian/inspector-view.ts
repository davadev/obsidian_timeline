import {
  ItemView,
  MarkdownRenderer,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  type App,
} from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import type { VaultAdapter } from "./vault-adapter";
import { parseEventNote } from "../timeline/markdown-parser";
import { renderEventMarkdown } from "../timeline/markdown-writer";
import type { TimelineEra, TimelineEvent } from "../timeline/model";
import {
  arrayBufferToBase64,
  guessImageExtension,
} from "../timeline/base64";

export const VIEW_TYPE_INSPECTOR = "txs-inspector-view";

export interface InspectorArgs {
  app: App;
  cache: TimelineCache;
  vault: VaultAdapter;
  getSettings: () => TimelineXmlSyncSettings;
  withSelfWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Called after the user saves edits in the inspector. */
  onEventSaved?: () => void;
}

/**
 * Right-sidebar inspector for editing the timeline-relevant fields of an
 * event without dropping into source mode. Loaded with one event id at a
 * time — the renderer's onOpenEvent dispatches into this view on every
 * click. Includes an "Open note" action so the user can still navigate to
 * the underlying Markdown file when they want to.
 */
export class InspectorView extends ItemView {
  private current?: TimelineEvent;
  private currentEra?: TimelineEra;
  private currentPath?: string;
  private dirty = false;

  constructor(leaf: WorkspaceLeaf, private args: InspectorArgs) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_INSPECTOR;
  }
  getDisplayText(): string {
    return "Timeline inspector";
  }
  getIcon(): string {
    return "info";
  }

  async onOpen(): Promise<void> {
    this.renderEmpty();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /**
   * Load an era for inspection. The era is sourced from cache.getRenderDoc()
   * so it picks up XML eras + any future MD overlay. The form is read-only
   * for fields the plugin can't yet round-trip back into XML (saving an era
   * is a TODO — for now the inspector shows the data and an Open era note
   * link).
   */
  async loadEra(eraId: string): Promise<void> {
    this.current = undefined;
    this.currentEra = undefined;
    try {
      const doc = await this.args.cache.getRenderDoc();
      const era = doc.eras?.find((e) => e.id === eraId);
      if (!era) {
        this.renderEmpty(`No era found with id "${eraId}".`);
        return;
      }
      this.currentEra = era;
      const eraPath = `${this.args.getSettings().eventNotesDir}/_eras/${eraId}.md`;
      this.currentPath = this.app.vault.getAbstractFileByPath(eraPath)
        ? eraPath
        : undefined;
      this.dirty = false;
      this.renderEraForm();
    } catch (e) {
      this.renderEmpty((e as Error).message);
    }
  }

  /** Loaded by the plugin's selectEvent() bus when a render block fires. */
  async loadEvent(eventId: string): Promise<void> {
    this.currentEra = undefined;
    const path = this.args.cache.resolvePath(eventId);
    if (!path) {
      this.renderEmpty(`No note found for event id "${eventId}".`);
      return;
    }
    try {
      const raw = await this.args.vault.readText(path);
      const parsed = parseEventNote(raw, {
        path,
        mirrorNames: this.args.getSettings().mirrorNames,
      });
      if (!parsed.note) {
        this.renderEmpty(`Note at "${path}" is not a timeline event.`);
        return;
      }
      this.current = await this.hydrateMissingEventFieldsFromXml(parsed.note.event);
      this.currentPath = path;
      this.dirty = false;
      this.renderForm();
    } catch (e) {
      this.renderEmpty((e as Error).message);
    }
  }

  /**
   * Some older/locally edited notes can have null timeline booleans even when
   * XML has explicit values. Fill only missing fields from the source XML so
   * inspector shows the effective event data without clobbering note values.
   */
  private async hydrateMissingEventFieldsFromXml(ev: TimelineEvent): Promise<TimelineEvent> {
    const needsXmlFallback =
      ev.period == null ||
      ev.showTime == null ||
      ev.fuzzyStart == null ||
      ev.fuzzyEnd == null;
    if (!needsXmlFallback) return ev;

    const sourceXml = ev.sourceXml ?? this.args.getSettings().sourceXmlPath;
    if (!sourceXml) return ev;

    try {
      const doc = await this.args.cache.getXml(sourceXml);
      const xmlEv = doc.events.find((e) => e.id === ev.id);
      if (!xmlEv) return ev;
      return {
        ...ev,
        period: ev.period ?? xmlEv.period,
        showTime: ev.showTime ?? xmlEv.showTime,
        fuzzyStart: ev.fuzzyStart ?? xmlEv.fuzzyStart,
        fuzzyEnd: ev.fuzzyEnd ?? xmlEv.fuzzyEnd,
      };
    } catch {
      return ev;
    }
  }

  private renderEraForm(): void {
    const era = this.currentEra;
    if (!era) return this.renderEmpty();
    this.contentEl.empty();
    this.contentEl.addClass("txs-inspector-root");

    const header = this.contentEl.createDiv({ cls: "txs-inspector-header" });
    header.createEl("h3", { text: `${era.name} — (era)` });
    if (this.currentPath) {
      const openBtn = header.createEl("button", {
        cls: "mod-cta",
        text: "Open era note",
      });
      openBtn.addEventListener("click", () => {
        if (this.currentPath) {
          this.app.workspace.openLinkText(this.currentPath, "", false);
        }
      });
    }

    const body = this.contentEl.createDiv({ cls: "txs-inspector-body" });

    body.createDiv({
      cls: "txs-inspector-meta",
      text:
        "Edits save to the era's Markdown note. The XML <eras> is updated on the next sync (auto-sync if enabled, or Regenerate XML from Markdown). XML is not written directly from here so per-device sync settings are respected.",
    });

    const nameRow = body.createDiv({ cls: "txs-inspector-row" });
    nameRow.createEl("label", { text: "Name" });
    const nameIn = nameRow.createEl("input", { type: "text" }) as HTMLInputElement;
    nameIn.value = era.name;
    nameIn.addEventListener("input", () => {
      era.name = nameIn.value;
      this.markDirty();
    });

    const startGroup = eraDateGroup(body, "Start", era.start);
    startGroup.onChange = () => this.markDirty();
    const endGroup = eraDateGroup(body, "End", era.end);
    endGroup.onChange = () => this.markDirty();

    const colorRow = body.createDiv({ cls: "txs-inspector-row" });
    colorRow.createEl("label", { text: "Color" });
    const colorWrap = colorRow.createDiv();
    colorWrap.style.display = "flex";
    colorWrap.style.gap = "6px";
    colorWrap.style.alignItems = "center";
    const picker = colorWrap.createEl("input", { type: "color" }) as HTMLInputElement;
    picker.value = colorToHex(era.color ?? "#888888");
    const colorIn = colorWrap.createEl("input", { type: "text" }) as HTMLInputElement;
    colorIn.value = era.color ?? "";
    colorIn.style.flex = "1 1 0";
    colorIn.placeholder = "r,g,b or #hex";
    picker.addEventListener("input", () => {
      // Store as the Timeline-XML-friendly "r,g,b" form so the round-trip
      // stays close to the original.
      const v = picker.value;
      const rgb = hexToRgbTriple(v);
      const stored = rgb ? `${rgb[0]},${rgb[1]},${rgb[2]}` : v;
      era.color = stored;
      colorIn.value = stored;
      this.markDirty();
    });
    colorIn.addEventListener("input", () => {
      era.color = colorIn.value.trim() || undefined;
      const hex = colorToHex(era.color ?? "#888888");
      picker.value = hex;
      this.markDirty();
    });

    const actions = this.contentEl.createDiv({ cls: "txs-inspector-actions" });
    const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Save era" });
    saveBtn.addEventListener("click", () => void this.saveEra());
    const revertBtn = actions.createEl("button", { text: "Reload from note" });
    revertBtn.addEventListener("click", () => void this.loadEra(era.id));
  }

  /** Persist current era edits as a Markdown note in `<eventNotesDir>/_eras/`. */
  private async saveEra(): Promise<void> {
    const era = this.currentEra;
    if (!era) return;
    const settings = this.args.getSettings();
    try {
      const { renderEraMarkdown } = await import("../timeline/era-md");
      const md = renderEraMarkdown(era, settings.timelineId, settings.sourceXmlPath);
      const path = `${settings.eventNotesDir}/_eras/${era.id}.md`;
      await this.args.vault.ensureFolder(`${settings.eventNotesDir}/_eras`);
      await this.args.withSelfWrite(async () => {
        await this.args.vault.writeText(path, md);
      });
      this.currentPath = path;
      this.args.cache.invalidateMdDoc();
      this.args.cache.updateFile(path);
      this.dirty = false;
      this.args.onEventSaved?.();
      new Notice("Era saved to Markdown. XML updates on next sync.");
    } catch (e) {
      new Notice(`Era save failed: ${(e as Error).message}`);
    }
  }

  private renderEmpty(msg = "Click any event in a timeline render to inspect it."): void {
    this.contentEl.empty();
    this.contentEl.addClass("txs-inspector-root");
    const placeholder = this.contentEl.createDiv({ cls: "txs-inspector-empty" });
    placeholder.createEl("p", { text: msg });
  }

  private renderForm(): void {
    const ev = this.current;
    if (!ev) return this.renderEmpty();
    this.contentEl.empty();
    this.contentEl.addClass("txs-inspector-root");
    const root = this.contentEl;

    const settings = this.args.getSettings();
    const cats = settings.knownCategories.length
      ? settings.knownCategories
      : [ev.category ?? "Uncategorized"];

    // Header
    const header = root.createDiv({ cls: "txs-inspector-header" });
    header.createEl("h3", { text: ev.text || "(untitled)" });
    const openBtn = header.createEl("button", {
      cls: "mod-cta",
      text: "Open note",
    });
    openBtn.addEventListener("click", () => {
      if (this.currentPath) {
        this.app.workspace.openLinkText(this.currentPath, "", false);
      }
    });

    const body = root.createDiv({ cls: "txs-inspector-body" });

    const titleInput = field(body, "Title", "input");
    (titleInput as HTMLInputElement).value = ev.text;
    titleInput.addEventListener("input", () => {
      ev.text = (titleInput as HTMLInputElement).value;
      this.markDirty();
    });

    // Category dropdown
    const catSelect = field(body, "Category", "select") as HTMLSelectElement;
    for (const c of cats) {
      const opt = catSelect.createEl("option", { value: c, text: c });
      if (c === ev.category) opt.selected = true;
    }
    catSelect.addEventListener("change", () => {
      ev.category = catSelect.value;
      this.markDirty();
    });

    const eventIdInput = field(body, "Event ID", "input");
    (eventIdInput as HTMLInputElement).value = ev.id;
    eventIdInput.addEventListener("input", () => {
      const v = (eventIdInput as HTMLInputElement).value.trim();
      if (v) {
        ev.id = v;
        this.markDirty();
      }
    });

    // Dates
    const startGroup = dateGroup(body, "Start", ev.start);
    startGroup.onChange = () => this.markDirty();
    const endGroup = dateGroup(body, "End", ev.end);
    endGroup.onChange = () => this.markDirty();

    // Native date picker. Hidden when either date is BCE — `<input type=date>`
    // can't represent year < 1, and showing it empty was a foot-gun on mobile:
    // tap → picker defaults to today → change event fires → BCE date got
    // overwritten with today. Both fields are pre-populated from the current
    // event so an accidental open + dismiss can't clobber the data.
    const ceSafe = ev.start.year >= 1 && ev.end.year >= 1;
    if (ceSafe) {
      const pickerWrap = body.createDiv({ cls: "txs-inspector-row" });
      pickerWrap.createEl("label", { text: "Quick picker (CE only)" });
      const sp = pickerWrap.createEl("input", { type: "date" }) as HTMLInputElement;
      const ep = pickerWrap.createEl("input", { type: "date" }) as HTMLInputElement;
      const startIso = toIsoDate(ev.start);
      const endIso = toIsoDate(ev.end);
      sp.defaultValue = startIso;
      ep.defaultValue = endIso;
      sp.value = startIso;
      ep.value = endIso;
      sp.addEventListener("change", () => {
        const d = fromIsoDate(sp.value);
        if (d && (d.year !== ev.start.year || d.month !== ev.start.month || d.day !== ev.start.day)) {
          ev.start = d;
          this.markDirty();
          this.renderForm();
        }
      });
      ep.addEventListener("change", () => {
        const d = fromIsoDate(ep.value);
        if (d && (d.year !== ev.end.year || d.month !== ev.end.month || d.day !== ev.end.day)) {
          ev.end = d;
          this.markDirty();
          this.renderForm();
        }
      });
    } else {
      body.createDiv({
        cls: "txs-inspector-meta",
        text: "Quick picker disabled for BCE dates — use the year/month/day inputs above.",
      });
    }

    // Description — textarea on top, live preview below. MarkdownRenderer
    // honors Obsidian wikilinks ([[Note]]) and transclusions (![[Note]]).
    const descRow = body.createDiv({ cls: "txs-inspector-row" });
    descRow.createEl("label", { text: "Description (Markdown / wikilinks / ![[embeds]])" });
    const descArea = descRow.createEl("textarea") as HTMLTextAreaElement;
    descArea.rows = 6;
    descArea.value = ev.description ?? "";
    const previewToggle = descRow.createEl("label", {
      cls: "txs-inspector-preview-toggle",
    });
    const previewCheck = previewToggle.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    previewCheck.checked = true;
    previewToggle.createEl("span", { text: " Preview" });
    const previewEl = descRow.createDiv({ cls: "txs-inspector-preview" });
    const renderPreview = () => {
      previewEl.empty();
      if (!previewCheck.checked) return;
      const text = descArea.value.trim();
      if (!text) {
        previewEl.createDiv({
          cls: "txs-inspector-meta",
          text: "(preview will render Markdown, [[wikilinks]], and ![[embeds]])",
        });
        return;
      }
      void MarkdownRenderer.render(
        this.app,
        text,
        previewEl,
        this.currentPath ?? "",
        this
      );
    };
    const debouncedRender = debounce(renderPreview, 200);
    descArea.addEventListener("input", () => {
      ev.description = descArea.value;
      this.markDirty();
      debouncedRender();
    });
    previewCheck.addEventListener("change", renderPreview);
    renderPreview();

    // Labels (UI accepts comma OR space OR semicolon — Timeline 2.11 XML uses
    // space-separated tokens, the writer converts on save).
    const labelsInput = field(body, "Labels (space / comma / ; separated)", "input");
    (labelsInput as HTMLInputElement).value = (ev.labels ?? []).join(" ");
    labelsInput.addEventListener("input", () => {
      ev.labels = (labelsInput as HTMLInputElement).value
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      this.markDirty();
    });

    // Hyperlink
    const linkInput = field(body, "Hyperlink", "input");
    (linkInput as HTMLInputElement).value = ev.hyperlink ?? "";
    linkInput.addEventListener("input", () => {
      const v = (linkInput as HTMLInputElement).value.trim();
      ev.hyperlink = v || undefined;
      this.markDirty();
    });

    const containerInput = field(body, "Container", "input");
    (containerInput as HTMLInputElement).value = ev.container ?? "";
    containerInput.addEventListener("input", () => {
      const v = (containerInput as HTMLInputElement).value.trim();
      ev.container = v || undefined;
      this.markDirty();
    });

    const defaultColorInput = field(body, "Default color", "input");
    (defaultColorInput as HTMLInputElement).value = ev.defaultColor ?? "";
    defaultColorInput.addEventListener("input", () => {
      const v = (defaultColorInput as HTMLInputElement).value.trim();
      ev.defaultColor = v || undefined;
      this.markDirty();
    });

    const timelineIdInput = field(body, "Timeline ID (timeline.id)", "input");
    (timelineIdInput as HTMLInputElement).value = ev.timelineId ?? settings.timelineId;
    timelineIdInput.addEventListener("input", () => {
      const v = (timelineIdInput as HTMLInputElement).value.trim();
      ev.timelineId = v || undefined;
      this.markDirty();
    });

    const roleInput = field(body, "Role", "input");
    (roleInput as HTMLInputElement).value = ev.role ?? "event";
    roleInput.addEventListener("input", () => {
      const v = (roleInput as HTMLInputElement).value.trim();
      ev.role = v || undefined;
      this.markDirty();
    });

    const sourceXmlInput = field(body, "Source XML", "input");
    (sourceXmlInput as HTMLInputElement).value = ev.sourceXml ?? settings.sourceXmlPath;
    sourceXmlInput.addEventListener("input", () => {
      const v = (sourceXmlInput as HTMLInputElement).value.trim();
      ev.sourceXml = v || undefined;
      this.markDirty();
    });

    const progressInput = field(body, "Progress", "input") as HTMLInputElement;
    progressInput.type = "number";
    progressInput.step = "0.01";
    progressInput.value = ev.progress != null ? String(ev.progress) : "";
    progressInput.addEventListener("input", () => {
      const raw = progressInput.value.trim();
      if (!raw) {
        ev.progress = undefined;
      } else {
        const n = Number(raw);
        if (Number.isFinite(n)) ev.progress = n;
      }
      this.markDirty();
    });

    const stampInput = field(body, "Last synced XML mtime", "input") as HTMLInputElement;
    stampInput.type = "number";
    stampInput.step = "1";
    stampInput.value = ev.lastSyncedXmlMtime != null ? String(ev.lastSyncedXmlMtime) : "";
    stampInput.addEventListener("input", () => {
      const raw = stampInput.value.trim();
      if (!raw) {
        ev.lastSyncedXmlMtime = undefined;
      } else {
        const n = Number(raw);
        if (Number.isFinite(n)) ev.lastSyncedXmlMtime = Math.trunc(n);
      }
      this.markDirty();
    });

    const flagsWrap = body.createDiv({ cls: "txs-inspector-flags" });
    flagsWrap.createDiv({ cls: "txs-inspector-section-title", text: "Timeline flags" });

    const periodCheck = boolField(flagsWrap, "Period", ev.period ?? false, (v) => {
      ev.period = v;
      this.markDirty();
    });
    const showTimeCheck = boolField(flagsWrap, "Show time", ev.showTime ?? false, (v) => {
      ev.showTime = v;
      this.markDirty();
    });
    const fuzzyStartCheck = boolField(flagsWrap, "Fuzzy start", ev.fuzzyStart ?? false, (v) => {
      ev.fuzzyStart = v;
      this.markDirty();
    });
    const fuzzyEndCheck = boolField(flagsWrap, "Fuzzy end", ev.fuzzyEnd ?? false, (v) => {
      ev.fuzzyEnd = v;
      this.markDirty();
    });
    void periodCheck;
    void showTimeCheck;
    void fuzzyStartCheck;
    void fuzzyEndCheck;

    const enabledCheck = boolField(flagsWrap, "Enabled", ev.timelineEnabled ?? true, (v) => {
      ev.timelineEnabled = v;
      this.markDirty();
    });
    const renderCheck = boolField(flagsWrap, "Render", ev.render ?? true, (v) => {
      ev.render = v;
      this.markDirty();
    });
    const endsTodayCheck = boolField(flagsWrap, "Ends today", ev.endsToday ?? false, (v) => {
      ev.endsToday = v;
      this.markDirty();
    });
    const fuzzyCheck = boolField(flagsWrap, "Fuzzy", ev.fuzzy ?? false, (v) => {
      ev.fuzzy = v;
      this.markDirty();
    });
    const lockedCheck = boolField(flagsWrap, "Locked", ev.locked ?? false, (v) => {
      ev.locked = v;
      this.markDirty();
    });
    void enabledCheck;
    void renderCheck;
    void endsTodayCheck;
    void fuzzyCheck;
    void lockedCheck;

    // Image
    const imageRow = body.createDiv({ cls: "txs-inspector-row" });
    imageRow.createEl("label", { text: "Image" });
    if (ev.iconAttachmentPath) {
      const file = this.app.vault.getAbstractFileByPath(ev.iconAttachmentPath);
      if (file instanceof TFile) {
        const url = this.app.vault.getResourcePath(file);
        const img = imageRow.createEl("img", { cls: "txs-inspector-thumb" });
        img.src = url;
      }
      imageRow.createEl("div", {
        cls: "txs-inspector-meta",
        text: ev.iconAttachmentPath,
      });
    }
    const fileInput = imageRow.createEl("input", {
      type: "file",
      attr: { accept: "image/*" },
    }) as HTMLInputElement;
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const buf = await f.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        const ext = guessImageExtension(b64);
        const settings = this.args.getSettings();
        const att = `${settings.eventNotesDir}/_attachments/${ev.id}.${ext}`;
        await this.args.vault.ensureFolder(`${settings.eventNotesDir}/_attachments`);
        await this.args.withSelfWrite(async () => {
          await this.args.vault.writeBinary(att, buf);
        });
        ev.iconAttachmentPath = att;
        ev.icon = b64;
        this.markDirty();
        this.renderForm();
      } catch (e) {
        new Notice(`Image upload failed: ${(e as Error).message}`);
      }
    });

    const actions = root.createDiv({ cls: "txs-inspector-actions" });
    const saveBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: "Save changes",
    });
    saveBtn.addEventListener("click", () => void this.save());
    const revertBtn = actions.createEl("button", { text: "Reload from note" });
    revertBtn.addEventListener("click", () => {
      const id = ev.id;
      void this.loadEvent(id);
    });
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private async save(): Promise<void> {
    if (!this.current || !this.currentPath) return;
    const settings = this.args.getSettings();
    try {
      const raw = await this.args.vault.readText(this.currentPath);
      const parsed = parseEventNote(raw, {
        path: this.currentPath,
        mirrorNames: settings.mirrorNames,
      });
      const extraFrontmatter = { ...(parsed.note?.extraFrontmatter ?? {}) };
      extraFrontmatter.title = this.current.text;
      const body = patchEventBody(parsed.note?.body ?? "", this.current);
      const md = renderEventMarkdown(this.current, {
        sourceXmlPath: settings.sourceXmlPath,
        timelineId: settings.timelineId,
        mirrorNames: settings.mirrorNames,
        extraFrontmatter,
        body,
        trimDescription: settings.trimDescriptionOnWrite,
      });
      await this.args.withSelfWrite(async () => {
        await this.args.vault.writeText(this.currentPath!, md);
      });
      this.args.cache.invalidateMdDoc();
      // Make sure the id index sees the latest event_id (in case the user
      // edited a note that was just created — metadataCache may not have
      // re-indexed yet).
      this.args.cache.updateFile(this.currentPath);
      this.dirty = false;
      this.args.onEventSaved?.();
      new Notice("Event note saved.");
    } catch (e) {
      new Notice(`Save failed: ${(e as Error).message}`);
    }
  }
}

function patchEventBody(body: string, ev: TimelineEvent): string {
  const withTitle = replaceOrInsertSection(body, /^\s*#\s+.*$/m, `# ${ev.text}`);
  const withText = replaceNamedSection(withTitle, "Text", ev.text);
  const desc = ev.description ?? "";
  return replaceNamedSection(withText, "Description", desc);
}

function replaceOrInsertSection(body: string, pattern: RegExp, replacement: string): string {
  if (pattern.test(body)) return body.replace(pattern, replacement);
  return `${replacement}\n\n${body}`;
}

function replaceNamedSection(body: string, name: string, value: string): string {
  const heading = new RegExp(`^##\\s+${escapeRe(name)}(?:\\s+#+)?\\s*$`, "im");
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (heading.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return `${body.trimEnd()}\n\n## ${name}\n\n${value}\n`;
  }
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i].trimStart();
    if (ln.startsWith("```") || ln.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  const middle = `\n${value}`;
  return `${before}${middle}${after ? `\n${after}` : ""}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function field(
  parent: HTMLElement,
  label: string,
  kind: "input" | "textarea" | "select"
): HTMLElement {
  const row = parent.createDiv({ cls: "txs-inspector-row" });
  row.createEl("label", { text: label });
  if (kind === "input") return row.createEl("input", { type: "text" });
  if (kind === "textarea") return row.createEl("textarea");
  return row.createEl("select");
}

interface DateGroupRef {
  onChange?: () => void;
}

function dateGroup(
  parent: HTMLElement,
  label: string,
  date: { year: number; month?: number; day?: number; hour?: number; minute?: number; second?: number }
): DateGroupRef {
  const ref: DateGroupRef = {};
  const row = parent.createDiv({ cls: "txs-inspector-row txs-date-row" });
  row.createEl("label", { text: label });
  const ymd = row.createDiv({ cls: "txs-date-fields" });
  const yIn = ymd.createEl("input", {
    type: "number",
    placeholder: "year",
  }) as HTMLInputElement;
  yIn.value = String(date.year);
  yIn.addEventListener("input", () => {
    const v = parseInt(yIn.value, 10);
    if (Number.isFinite(v)) {
      date.year = v;
      ref.onChange?.();
    }
  });
  const mIn = ymd.createEl("input", {
    type: "number",
    placeholder: "mm",
    attr: { min: "1", max: "12" },
  }) as HTMLInputElement;
  if (date.month != null) mIn.value = String(date.month);
  mIn.addEventListener("input", () => {
    const v = parseInt(mIn.value, 10);
    date.month = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  const dIn = ymd.createEl("input", {
    type: "number",
    placeholder: "dd",
    attr: { min: "1", max: "31" },
  }) as HTMLInputElement;
  if (date.day != null) dIn.value = String(date.day);
  dIn.addEventListener("input", () => {
    const v = parseInt(dIn.value, 10);
    date.day = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  const hIn = ymd.createEl("input", {
    type: "number",
    placeholder: "hh",
    attr: { min: "0", max: "23" },
  }) as HTMLInputElement;
  if (date.hour != null) hIn.value = String(date.hour);
  hIn.addEventListener("input", () => {
    const v = parseInt(hIn.value, 10);
    date.hour = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  const minIn = ymd.createEl("input", {
    type: "number",
    placeholder: "min",
    attr: { min: "0", max: "59" },
  }) as HTMLInputElement;
  if (date.minute != null) minIn.value = String(date.minute);
  minIn.addEventListener("input", () => {
    const v = parseInt(minIn.value, 10);
    date.minute = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  const sIn = ymd.createEl("input", {
    type: "number",
    placeholder: "sec",
    attr: { min: "0", max: "59" },
  }) as HTMLInputElement;
  if (date.second != null) sIn.value = String(date.second);
  sIn.addEventListener("input", () => {
    const v = parseInt(sIn.value, 10);
    date.second = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  return ref;
}

function boolField(
  parent: HTMLElement,
  label: string,
  value: boolean,
  onChange: (next: boolean) => void
): HTMLInputElement {
  const row = parent.createDiv({ cls: "txs-inspector-toggle-row" });
  row.createSpan({ text: label });
  const input = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = value;
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}


function toIsoDate(d: { year: number; month?: number; day?: number }): string {
  const m = d.month ?? 1;
  const day = d.day ?? 1;
  return `${String(d.year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface EraDateGroupRef {
  onChange?: () => void;
}

function eraDateGroup(
  parent: HTMLElement,
  label: string,
  date: { year: number; month?: number; day?: number }
): EraDateGroupRef {
  const ref: EraDateGroupRef = {};
  const row = parent.createDiv({ cls: "txs-inspector-row txs-date-row" });
  row.createEl("label", { text: label });
  const ymd = row.createDiv({ cls: "txs-date-fields" });
  const mk = (placeholder: string, value: number | undefined): HTMLInputElement => {
    const i = ymd.createEl("input", { type: "number", placeholder }) as HTMLInputElement;
    if (value != null) i.value = String(value);
    return i;
  };
  const yIn = mk("year", date.year);
  const moIn = mk("mm", date.month);
  const dIn = mk("dd", date.day);
  yIn.addEventListener("input", () => {
    const v = parseInt(yIn.value, 10);
    if (Number.isFinite(v)) {
      date.year = v;
      ref.onChange?.();
    }
  });
  moIn.addEventListener("input", () => {
    const v = parseInt(moIn.value, 10);
    date.month = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  dIn.addEventListener("input", () => {
    const v = parseInt(dIn.value, 10);
    date.day = Number.isFinite(v) ? v : undefined;
    ref.onChange?.();
  });
  return ref;
}

function colorToHex(raw: string): string {
  const s = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  const m3 = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase();
  const rgb = s.match(/^(\d+),(\d+),(\d+)$/) || s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const h = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
    return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}`;
  }
  return "#888888";
}

function hexToRgbTriple(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}

function fromIsoDate(s: string): { year: number; month: number; day: number } | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
  };
}
