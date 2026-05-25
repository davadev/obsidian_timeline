import { ItemView, Platform, WorkspaceLeaf, type App } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import { renderTimeline } from "../renderer";
import type { TimelineDoc, TimelineEvent } from "../timeline/model";
import { compare, type TimelineDate } from "../timeline/date";
import { distinctCategories, renderFilterBar } from "../renderer/filter-bar";

export const VIEW_TYPE_TIMELINE = "txs-timeline-view";

export interface TimelineViewArgs {
  app: App;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
  onEventClick: (id: string) => void;
}

interface ViewFilters {
  search: string;
  start: TimelineDate | null;
  end: TimelineDate | null;
  labels: string[];
  hiddenCategories: Set<string>;
}

const EMPTY_FILTERS = (): ViewFilters => ({
  search: "",
  start: null,
  end: null,
  labels: [],
  hiddenCategories: new Set(),
});

/**
 * Workspace-leaf view (like the Graph view) showing the entire timeline.
 * Filter panel is a collapsible <details> that hosts search, granular date
 * inputs (year — or year+month+day — or full datetime, per setting), label
 * filter, and the category chip bar.
 *
 * Inline ` ```timeline ` blocks keep their own above-block filter bar; the
 * global view is the only place where the chips live inside the filters.
 */
export class TimelineView extends ItemView {
  private filters: ViewFilters = EMPTY_FILTERS();
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
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /**
   * Reload `cachedDoc` from the cache and re-render the body without
   * destroying the filter panel state. Called by the plugin whenever event
   * notes change (inspector save, new-event flow, external file write).
   */
  async refreshFromCache(): Promise<void> {
    try {
      this.cachedDoc = await this.args.cache.getRenderDoc();
    } catch {
      return;
    }
    this.bodyRender();
  }

  private async fullRender(): Promise<void> {
    const { cache, getSettings, app } = this.args;
    const settings = getSettings();
    this.contentEl.empty();
    this.contentEl.addClass("txs-view-root");

    const header = this.contentEl.createDiv({ cls: "txs-view-header" });
    header.createEl("h3", { text: "Timeline" });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.addEventListener("click", () => {
      cache.invalidateXml();
      cache.invalidateMdDoc();
      this.cachedDoc = null;
      void this.fullRender();
    });

    // Load doc first — we need categories to populate the chip bar.
    try {
      this.cachedDoc = await cache.getRenderDoc();
    } catch (e) {
      this.contentEl.createDiv({
        cls: "txs-error",
        text: `Timeline view error: ${(e as Error).message}`,
      });
      return;
    }

    this.buildFilterPanel(settings);
    this.contentEl.createDiv({ cls: "txs-view-body" });
    this.bodyRender();
  }

  private buildFilterPanel(settings: TimelineXmlSyncSettings): void {
    const doc = this.cachedDoc;
    if (!doc) return;

    const panel = this.contentEl.createEl("details", {
      cls: "txs-view-filters",
    }) as HTMLDetailsElement;
    if (!Platform.isMobile) panel.open = true;

    const summary = panel.createEl("summary", {
      cls: "txs-view-filters-summary",
    });
    const badge = summary.createEl("span", {
      cls: "txs-view-filters-badge",
      text: "Filters",
    });

    const updateBadge = () => {
      const n =
        (this.filters.search ? 1 : 0) +
        (this.filters.start ? 1 : 0) +
        (this.filters.end ? 1 : 0) +
        (this.filters.labels.length ? 1 : 0) +
        (this.filters.hiddenCategories.size ? 1 : 0);
      badge.textContent = n ? `Filters (${n} active)` : "Filters";
    };

    // Search
    const searchInput = panel.createEl("input", {
      cls: "txs-view-search",
      type: "search",
      placeholder: "Search title / description / category…",
    });
    searchInput.value = this.filters.search;
    searchInput.addEventListener("input", () => {
      this.filters.search = searchInput.value;
      updateBadge();
      this.bodyRender();
    });

    // Date range — granularity comes from settings.
    const dateBox = panel.createDiv({ cls: "txs-view-date-row" });
    dateBox.createEl("span", {
      cls: "txs-view-range-label",
      text: "From → to:",
    });
    const startGroup = renderDateInputs(
      dateBox,
      this.filters.start,
      settings.globalFilterPrecision,
      (d) => {
        this.filters.start = d;
        updateBadge();
        this.bodyRender();
      }
    );
    dateBox.createEl("span", { text: "→" });
    const endGroup = renderDateInputs(
      dateBox,
      this.filters.end,
      settings.globalFilterPrecision,
      (d) => {
        this.filters.end = d;
        updateBadge();
        this.bodyRender();
      }
    );

    // Labels
    const labelsInput = panel.createEl("input", {
      cls: "txs-view-labels",
      type: "text",
      placeholder: "labels (space / comma / ;)",
    });
    labelsInput.value = this.filters.labels.join(" ");
    labelsInput.addEventListener("input", () => {
      this.filters.labels = labelsInput.value
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      updateBadge();
      this.bodyRender();
    });

    // Categories — chip bar lives INSIDE the filter panel for the global view.
    const cats = distinctCategories(doc.events, doc.categories);
    if (cats.length) {
      renderFilterBar({
        parent: panel,
        sourceKey: `view:${settings.timelineId}`,
        allCategories: cats,
        initialHidden: Array.from(this.filters.hiddenCategories.size
          ? this.filters.hiddenCategories
          : new Set(settings.hiddenCategories)),
        categoryColors: settings.categoryColors,
        onChange: (hidden) => {
          this.filters.hiddenCategories = hidden;
          updateBadge();
          this.bodyRender();
        },
      });
      // Seed local set with the persisted chip state for initial render.
      if (!this.filters.hiddenCategories.size) {
        this.filters.hiddenCategories = new Set(settings.hiddenCategories);
      }
    }

    // Clear
    const clearBtn = panel.createEl("button", { text: "Clear filters" });
    clearBtn.addEventListener("click", () => {
      this.filters = EMPTY_FILTERS();
      searchInput.value = "";
      labelsInput.value = "";
      startGroup.reset();
      endGroup.reset();
      updateBadge();
      this.bodyRender();
    });

    updateBadge();
  }

  private bodyRender(): void {
    const body = this.contentEl.querySelector(".txs-view-body") as HTMLElement;
    if (!body) return;
    const bodyScrollTop = body.scrollTop;
    const barScrolls: number[] = [];
    body.querySelectorAll<HTMLElement>(".txs-timeline-bar").forEach((b) => {
      barScrolls.push(b.scrollLeft);
    });

    body.empty();
    if (!this.cachedDoc) return;
    const { cache, getSettings, app } = this.args;
    const settings = getSettings();

    let filtered = applyFilters(this.cachedDoc.events, this.filters);
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
      eras: this.cachedDoc.eras,
      viewport: fullViewport,
      options: {
        ...settings.renderDefaults,
        mode: settings.renderDefaults.mode,
        zoom: autoZoom,
        show: ["title", "date", "category"],
        details: "compact",
        // Category chips are in the filter panel for the global view, so the
        // renderer's own chip bar would be duplicate noise.
        showFilterUI: false,
      },
      onOpenEvent: (id) => this.args.onEventClick(id),
      categoryColors: settings.categoryColors,
      // Already filtered by our hiddenCategories above — don't double-filter.
      initialHidden: [],
      filterKey: `view:${settings.timelineId}`,
      isMobile: Platform.isMobile,
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        body.scrollTop = bodyScrollTop;
        body
          .querySelectorAll<HTMLElement>(".txs-timeline-bar")
          .forEach((b, i) => {
            if (i < barScrolls.length) b.scrollLeft = barScrolls[i];
          });
      });
    });
  }
}

function applyFilters(events: TimelineEvent[], f: ViewFilters): TimelineEvent[] {
  const q = f.search.trim().toLowerCase();
  const hidden = f.hiddenCategories;
  return events.filter((e) => {
    if (hidden.size && e.category && hidden.has(e.category)) return false;
    if (q) {
      const hay = `${e.text}\n${e.description ?? ""}\n${e.category ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.start && compare(e.end, f.start) < 0) return false;
    if (f.end && compare(e.start, f.end) > 0) return false;
    if (f.labels.length) {
      const need = new Set(f.labels.map((s) => s.toLowerCase()));
      const have = (e.labels ?? []).map((s) => s.toLowerCase());
      if (!have.some((l) => need.has(l))) return false;
    }
    return true;
  });
}

interface DateGroupHandle {
  reset: () => void;
}

/**
 * Renders the date inputs for one side of the range. `precision` controls
 * which fields are emitted. Calls `onChange` with the assembled TimelineDate
 * (or null when the year field is cleared) after every keystroke.
 */
function renderDateInputs(
  parent: HTMLElement,
  initial: TimelineDate | null,
  precision: "year" | "day" | "time",
  onChange: (d: TimelineDate | null) => void
): DateGroupHandle {
  const wrap = parent.createDiv({ cls: "txs-view-date-fields" });
  const inputs: HTMLInputElement[] = [];
  const mk = (placeholder: string, value: number | undefined, width: number) => {
    const i = wrap.createEl("input", {
      type: "number",
      placeholder,
    }) as HTMLInputElement;
    i.style.width = `${width}px`;
    if (value != null) i.value = String(value);
    inputs.push(i);
    return i;
  };
  const yIn = mk("year", initial?.year, 70);
  let moIn: HTMLInputElement | null = null;
  let dIn: HTMLInputElement | null = null;
  let hIn: HTMLInputElement | null = null;
  let miIn: HTMLInputElement | null = null;
  let sIn: HTMLInputElement | null = null;
  if (precision === "day" || precision === "time") {
    moIn = mk("mo", initial?.month, 40);
    dIn = mk("dd", initial?.day, 40);
  }
  if (precision === "time") {
    hIn = mk("hh", initial?.hour, 40);
    miIn = mk("mm", initial?.minute, 40);
    sIn = mk("ss", initial?.second, 40);
  }

  const fire = () => {
    const y = yIn.value.trim();
    if (y === "") {
      onChange(null);
      return;
    }
    const year = parseInt(y, 10);
    if (!Number.isFinite(year)) {
      onChange(null);
      return;
    }
    const intOf = (el: HTMLInputElement | null) => {
      if (!el || el.value.trim() === "") return undefined;
      const n = parseInt(el.value, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    onChange({
      year,
      month: intOf(moIn),
      day: intOf(dIn),
      hour: intOf(hIn),
      minute: intOf(miIn),
      second: intOf(sIn),
    });
  };

  for (const i of inputs) i.addEventListener("input", fire);

  return {
    reset: () => {
      for (const i of inputs) i.value = "";
    },
  };
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
