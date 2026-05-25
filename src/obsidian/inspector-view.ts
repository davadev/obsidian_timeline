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
import type { TimelineEvent } from "../timeline/model";
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

  /** Loaded by the plugin's selectEvent() bus when a render block fires. */
  async loadEvent(eventId: string): Promise<void> {
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
      this.current = parsed.note.event;
      this.currentPath = path;
      this.dirty = false;
      this.renderForm();
    } catch (e) {
      this.renderEmpty((e as Error).message);
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
      const md = renderEventMarkdown(this.current, {
        sourceXmlPath: settings.sourceXmlPath,
        timelineId: settings.timelineId,
        mirrorNames: settings.mirrorNames,
        extraFrontmatter: parsed.note?.extraFrontmatter,
        body: parsed.note?.body,
      });
      await this.args.withSelfWrite(async () => {
        await this.args.vault.writeText(this.currentPath!, md);
      });
      this.args.cache.invalidateMdDoc();
      this.dirty = false;
      new Notice("Event note saved.");
    } catch (e) {
      new Notice(`Save failed: ${(e as Error).message}`);
    }
  }
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
  date: { year: number; month?: number; day?: number }
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
  return ref;
}

function toIsoDate(d: { year: number; month?: number; day?: number }): string {
  const m = d.month ?? 1;
  const day = d.day ?? 1;
  return `${String(d.year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
