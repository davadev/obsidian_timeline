import { ItemView, Platform, WorkspaceLeaf, type App } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import { renderTimeline } from "../renderer";
import type { TimelineDoc, TimelineEvent } from "../timeline/model";
import { compare } from "../timeline/date";

export const VIEW_TYPE_TIMELINE = "txs-timeline-view";

export interface TimelineViewArgs {
  app: App;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
}

interface ViewFilters {
  search: string;
  startYear: number | null;
  endYear: number | null;
}

const EMPTY_FILTERS: ViewFilters = {
  search: "",
  startYear: null,
  endYear: null,
};

/**
 * Workspace-leaf view (like the Graph view) showing the entire timeline.
 * Honors the same eventSource preference as the inline render block, so it
 * works on iOS even when no .timeline XML is present.
 */
export class TimelineView extends ItemView {
  private filters: ViewFilters = { ...EMPTY_FILTERS };
  private cachedDoc: TimelineDoc | null = null;

  constructor(leaf: WorkspaceLeaf, private args: TimelineViewArgs) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TIMELINE;
  }

  getDisplayText(): string {
    return "Timeline";
  }

  getIcon(): string {
    return "calendar-range";
  }

  async onOpen(): Promise<void> {
    await this.fullRender();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.app.workspace.getActiveViewOfType(TimelineView) === this) {
          void this.fullRender();
        }
      })
    );
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Full re-render including header + filters + body. */
  private async fullRender(): Promise<void> {
    const { cache, getSettings, app } = this.args;
    const settings = getSettings();
    this.contentEl.empty();
    this.contentEl.addClass("txs-view-root");

    // Header: title + refresh button
    const header = this.contentEl.createDiv({ cls: "txs-view-header" });
    header.createEl("h3", { text: "Timeline" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.addEventListener("click", () => {
      cache.invalidateXml();
      cache.invalidateMdDoc();
      this.cachedDoc = null;
      void this.fullRender();
    });

    // Filter row: search + date range
    const filterRow = this.contentEl.createDiv({ cls: "txs-view-filters" });
    const searchInput = filterRow.createEl("input", {
      cls: "txs-view-search",
      type: "search",
      placeholder: "Search title / description / category…",
    });
    searchInput.value = this.filters.search;
    searchInput.addEventListener("input", () => {
      this.filters.search = searchInput.value;
      this.bodyRender();
    });

    const rangeLabel = filterRow.createEl("span", {
      cls: "txs-view-range-label",
      text: "Years:",
    });
    rangeLabel.title = "Inclusive year range. Use negative numbers for BCE.";
    const startInput = filterRow.createEl("input", {
      cls: "txs-view-year",
      type: "number",
      placeholder: "from",
    });
    if (this.filters.startYear != null) startInput.value = String(this.filters.startYear);
    startInput.addEventListener("input", () => {
      const v = startInput.value.trim();
      this.filters.startYear = v === "" ? null : parseInt(v, 10);
      if (this.filters.startYear != null && !Number.isFinite(this.filters.startYear)) {
        this.filters.startYear = null;
      }
      this.bodyRender();
    });

    const endInput = filterRow.createEl("input", {
      cls: "txs-view-year",
      type: "number",
      placeholder: "to",
    });
    if (this.filters.endYear != null) endInput.value = String(this.filters.endYear);
    endInput.addEventListener("input", () => {
      const v = endInput.value.trim();
      this.filters.endYear = v === "" ? null : parseInt(v, 10);
      if (this.filters.endYear != null && !Number.isFinite(this.filters.endYear)) {
        this.filters.endYear = null;
      }
      this.bodyRender();
    });

    const clearBtn = filterRow.createEl("button", { text: "Clear" });
    clearBtn.addEventListener("click", () => {
      this.filters = { ...EMPTY_FILTERS };
      searchInput.value = "";
      startInput.value = "";
      endInput.value = "";
      this.bodyRender();
    });

    // Body (re-rendered on filter changes)
    this.contentEl.createDiv({ cls: "txs-view-body" });

    // Load doc once per fullRender — subsequent filter changes reuse it.
    try {
      const xmlPath = settings.sourceXmlPath;
      const xmlAvailable =
        !!xmlPath && app.vault.getAbstractFileByPath(xmlPath) !== null;
      if (settings.eventSource === "xml") {
        if (!xmlAvailable) throw new Error(`XML not found: ${xmlPath}`);
        this.cachedDoc = await cache.getXml(xmlPath);
      } else if (settings.eventSource === "md") {
        this.cachedDoc = await cache.getMdDoc();
      } else {
        this.cachedDoc = xmlAvailable
          ? await cache.getXml(xmlPath)
          : await cache.getMdDoc();
      }
    } catch (e) {
      this.contentEl
        .querySelector(".txs-view-body")!
        .createDiv({
          cls: "txs-error",
          text: `Timeline view error: ${(e as Error).message}`,
        });
      return;
    }

    this.bodyRender();
  }

  /** Re-render only the body using the cached doc + current filters. */
  private bodyRender(): void {
    const body = this.contentEl.querySelector(".txs-view-body") as HTMLElement;
    if (!body) return;
    body.empty();
    if (!this.cachedDoc) return;
    const { cache, getSettings, app } = this.args;
    const settings = getSettings();

    const filtered = applyFilters(this.cachedDoc.events, this.filters);
    if (!filtered.length) {
      body.createDiv({ text: "No events match current filters." });
      return;
    }

    const fullViewport = autoViewport(filtered);
    const autoZoom = pickAutoZoom(filtered.length, fullViewport, body);
    renderTimeline({
      container: body,
      events: filtered,
      categories: this.cachedDoc.categories,
      viewport: fullViewport,
      options: {
        ...settings.renderDefaults,
        mode: settings.renderDefaults.mode,
        zoom: autoZoom,
        // Global view list: only title/date/category + Open link. No descriptions.
        show: ["title", "date", "category"],
        details: "compact",
        showFilterUI: true,
      },
      onOpenEvent: (id) => {
        const path = cache.resolvePath(id);
        if (path) app.workspace.openLinkText(path, "", false);
      },
      categoryColors: settings.categoryColors,
      initialHidden: settings.hiddenCategories,
      filterKey: `view:${settings.timelineId}`,
      isMobile: Platform.isMobile,
    });
  }
}

function applyFilters(events: TimelineEvent[], f: ViewFilters): TimelineEvent[] {
  const q = f.search.trim().toLowerCase();
  return events.filter((e) => {
    if (q) {
      const hay = `${e.text}\n${e.description ?? ""}\n${e.category ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.startYear != null) {
      // event must end at or after startYear
      if (compare(e.end, { year: f.startYear, month: 1, day: 1 }) < 0) return false;
    }
    if (f.endYear != null) {
      if (compare(e.start, { year: f.endYear, month: 12, day: 31 }) > 0) return false;
    }
    return true;
  });
}

function autoViewport(events: { start: { year: number }; end: { year: number } }[]) {
  if (!events.length) return undefined;
  let minY = events[0].start.year;
  let maxY = events[0].end.year;
  for (const e of events) {
    if (e.start.year < minY) minY = e.start.year;
    if (e.end.year > maxY) maxY = e.end.year;
  }
  const span = Math.max(1, maxY - minY);
  const pad = Math.max(1, Math.floor(span * 0.02));
  return { start: { year: minY - pad }, end: { year: maxY + pad } };
}

function pickAutoZoom(
  eventCount: number,
  vp: { start: { year: number }; end: { year: number } } | undefined,
  container: HTMLElement
): number {
  if (!vp) return 1;
  const width = Math.max(320, container.clientWidth || 800);
  const span = Math.max(1, vp.end.year - vp.start.year);
  const desiredByEvents = Math.ceil((eventCount * 60) / width);
  const desiredByYears = Math.ceil((span * 3) / width);
  const z = Math.max(1, desiredByEvents, desiredByYears);
  return Math.min(50, z);
}
