import { ItemView, Platform, WorkspaceLeaf, type App } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import { renderTimeline } from "../renderer";
import type { TimelineDoc, TimelineEvent } from "../timeline/model";
import { type TimelineDate } from "../timeline/date";
import {
  applyRichFilter,
  distinctCategories,
  renderFilterBar,
  type RichFilterState,
} from "../renderer/filter-bar";
import {
  ZOOM_STEP,
  clampZoom,
  focalScroll,
  formatZoom,
  wheelZoomFactor,
} from "../renderer/zoom-math";

export const VIEW_TYPE_TIMELINE = "txs-timeline-view";

export interface TimelineViewArgs {
  app: App;
  cache: TimelineCache;
  getSettings: () => TimelineXmlSyncSettings;
  onEventClick: (id: string) => void;
  onEraClick: (id: string) => void;
}

interface ViewFilters {
  search: string;
  start: TimelineDate | null;
  end: TimelineDate | null;
  labels: string[];
  hiddenCategories: Set<string>;
  zoom: number | null;
}

const EMPTY_FILTERS = (): ViewFilters => ({
  search: "",
  start: null,
  end: null,
  labels: [],
  hiddenCategories: new Set(),
  zoom: null,
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

  /** Survives a full re-render; mobile starts collapsed to save screen. */
  private filtersOpen = !Platform.isMobile;
  /** Zoom actually used by the last render — the base that +/- and pinch scale. */
  private effectiveZoom = 1;
  private zoomLabelEl: HTMLElement | null = null;
  /** Scroll position the next render should land on, to keep the pinch focal point still. */
  private pendingBarScroll: { left: number; top: number } | null = null;
  private zoomFrame: number | null = null;

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
    const { cache, getSettings } = this.args;
    const settings = getSettings();
    this.contentEl.empty();
    this.contentEl.addClass("txs-view-root");

    const header = this.contentEl.createDiv({ cls: "txs-view-header" });
    header.createEl("h3", { text: "Timeline" });

    // Zoom: pinch on touch and ctrl/trackpad-pinch on desktop do the real
    // work; these are the discoverable fallback (and the reset).
    const zoomGroup = header.createDiv({ cls: "txs-view-zoom" });
    const zoomOut = zoomGroup.createEl("button", {
      text: "−",
      attr: { type: "button", "aria-label": "Zoom out" },
    });
    this.zoomLabelEl = zoomGroup.createEl("button", {
      cls: "txs-view-zoom-label",
      attr: { type: "button", "aria-label": "Reset zoom to automatic" },
    });
    const zoomIn = zoomGroup.createEl("button", {
      text: "+",
      attr: { type: "button", "aria-label": "Zoom in" },
    });
    zoomOut.addEventListener("click", () => this.zoomBy(1 / ZOOM_STEP));
    zoomIn.addEventListener("click", () => this.zoomBy(ZOOM_STEP));
    this.zoomLabelEl.addEventListener("click", () => this.resetZoom());
    this.updateZoomLabel();

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
    const body = this.contentEl.createDiv({ cls: "txs-view-body" });
    this.attachZoomGestures(body);
    this.bodyRender();
  }

  private buildFilterPanel(settings: TimelineXmlSyncSettings): void {
    const doc = this.cachedDoc;
    if (!doc) return;

    // Deliberately NOT a <details>. WebKit toggles the disclosure for clicks
    // anywhere inside it once the summary is styled, which collapsed the panel
    // whenever a control in it was tapped. A div + button has no such
    // behaviour to fight.
    const panel = this.contentEl.createDiv({ cls: "txs-view-filters" });
    panel.toggleClass("is-open", this.filtersOpen);

    const summary = panel.createEl("button", {
      cls: "txs-view-filters-summary",
      attr: { type: "button", "aria-expanded": String(this.filtersOpen) },
    });
    const badge = summary.createSpan({
      cls: "txs-view-filters-badge",
      text: "Filters",
    });
    summary.addEventListener("click", () => {
      this.filtersOpen = !this.filtersOpen;
      panel.toggleClass("is-open", this.filtersOpen);
      summary.setAttr("aria-expanded", String(this.filtersOpen));
    });

    // Every control lives in its own scrollable box: the panel is taller than
    // the view on phones (and in short desktop panes), and without this the
    // rows past the fold sit under Obsidian's bottom bar with no way to reach
    // them. The summary stays pinned above it.
    const controls = panel.createDiv({ cls: "txs-view-filters-body" });

    const updateBadge = () => {
      const n =
        (this.filters.search ? 1 : 0) +
        (this.filters.start ? 1 : 0) +
        (this.filters.end ? 1 : 0) +
        (this.filters.labels.length ? 1 : 0) +
        (this.filters.hiddenCategories.size ? 1 : 0);
      badge.textContent = n ? `Filters (${n} active)` : "Filters";
    };

    // Coalesce keystrokes — don't re-render on every character.
    let renderTimer: number | null = null;
    const scheduleRender = () => {
      if (renderTimer) window.clearTimeout(renderTimer);
      renderTimer = window.setTimeout(() => {
        renderTimer = null;
        this.bodyRender();
      }, 250);
    };

    // Search
    const searchInput = controls.createEl("input", {
      cls: "txs-view-search",
      type: "search",
      placeholder: "Search title / description / category…",
    });
    searchInput.value = this.filters.search;
    searchInput.addEventListener("input", () => {
      this.filters.search = searchInput.value;
      updateBadge();
      scheduleRender();
    });

    // Date range — granularity comes from settings.
    const dateBox = controls.createDiv({ cls: "txs-view-date-row" });
    dateBox.createSpan({
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
    dateBox.createSpan({ text: "→" });
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
    const labelsInput = controls.createEl("input", {
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
      scheduleRender();
    });

    // Categories — chip bar lives INSIDE the filter panel for the global view.
    const cats = distinctCategories(doc.events, doc.categories);
    if (cats.length) {
      renderFilterBar({
        parent: controls,
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
    const clearBtn = controls.createEl("button", { text: "Clear filters" });
    clearBtn.addEventListener("click", () => {
      this.filters = EMPTY_FILTERS();
      searchInput.value = "";
      labelsInput.value = "";
      startGroup.reset();
      endGroup.reset();
      this.updateZoomLabel();
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
    const { getSettings } = this.args;
    const settings = getSettings();

    let filtered = applyFilters(this.cachedDoc.events, this.filters);
    if (!filtered.length) {
      body.createDiv({ text: "No events match current filters." });
      return;
    }

    const fullViewport = autoViewport(filtered);
    const computedZoom = pickAutoZoom(filtered.length, fullViewport, body);
    const autoZoom = this.filters.zoom != null ? this.filters.zoom : computedZoom;
    this.effectiveZoom = autoZoom;
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
      onOpenEra: (id) => this.args.onEraClick(id),
      categoryColors: settings.categoryColors,
      // Already filtered by our hiddenCategories above — don't double-filter.
      initialHidden: [],
      filterKey: `view:${settings.timelineId}`,
      isMobile: Platform.isMobile,
      fuzzyGradientPercent: settings.fuzzyGradientPercent,
      eventLabelColor: settings.eventLabelColor,
    });

    const plan = this.pendingBarScroll;
    this.pendingBarScroll = null;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        body.scrollTop = bodyScrollTop;
        body
          .querySelectorAll<HTMLElement>(".txs-timeline-bar")
          .forEach((b, i) => {
            if (plan) {
              // Zoom: keep whatever was under the pointer/fingers in place.
              b.scrollLeft = plan.left;
              b.scrollTop = plan.top;
            } else if (i < barScrolls.length) {
              b.scrollLeft = barScrolls[i];
            }
          });
      });
    });
  }

  /** The horizontally (or vertically) scrolling box the bar chart lives in. */
  private barScroller(): HTMLElement | null {
    return this.contentEl.querySelector(".txs-timeline-bar");
  }

  private updateZoomLabel(): void {
    if (!this.zoomLabelEl) return;
    const z = this.filters.zoom;
    this.zoomLabelEl.textContent = z == null ? "Auto" : `${formatZoom(z)}×`;
  }

  /** Multiply the current zoom, keeping `focalClient` (px, viewport) steady. */
  private zoomBy(factor: number, focalClient?: { x: number; y: number }): void {
    const from = this.filters.zoom ?? this.effectiveZoom;
    this.setZoom(from * factor, from, focalClient);
  }

  private setZoom(
    next: number,
    from: number,
    focalClient?: { x: number; y: number }
  ): void {
    const clamped = clampZoom(next);
    if (Math.abs(clamped - from) < 0.001) return;

    const scroller = this.barScroller();
    if (scroller) {
      const ratio = clamped / from;
      const rect = scroller.getBoundingClientRect();
      const fx = focalClient ? focalClient.x - rect.left : rect.width / 2;
      const fy = focalClient ? focalClient.y - rect.top : rect.height / 2;
      this.pendingBarScroll = {
        left: focalScroll(scroller.scrollLeft, fx, ratio),
        top: focalScroll(scroller.scrollTop, fy, ratio),
      };
    }

    this.filters.zoom = clamped;
    this.updateZoomLabel();
    this.scheduleZoomRender();
  }

  private resetZoom(): void {
    if (this.filters.zoom == null) return;
    this.filters.zoom = null;
    this.pendingBarScroll = null;
    this.updateZoomLabel();
    this.scheduleZoomRender();
  }

  /** One render per frame, so a pinch does not queue dozens of them. */
  private scheduleZoomRender(): void {
    if (this.zoomFrame != null) return;
    this.zoomFrame = window.requestAnimationFrame(() => {
      this.zoomFrame = null;
      this.bodyRender();
    });
  }

  /**
   * Pinch to zoom on touch, ctrl+wheel (which is what a trackpad pinch sends)
   * on desktop. Both keep the point under the fingers/cursor anchored.
   */
  private attachZoomGestures(body: HTMLElement): void {
    body.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (!e.ctrlKey) return; // plain scrolling stays scrolling
        e.preventDefault();
        this.zoomBy(wheelZoomFactor(e.deltaY), { x: e.clientX, y: e.clientY });
      },
      { passive: false }
    );

    const points = new Map<number, { x: number; y: number }>();
    let startDist = 0;
    let startZoom = 1;

    const spread = (): number => {
      const [a, b] = Array.from(points.values());
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const centre = (): { x: number; y: number } => {
      const [a, b] = Array.from(points.values());
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const endPinch = () => {
      if (points.size >= 2) return;
      startDist = 0;
      // Let the tap-suppression outlive the gesture by a frame or two, so
      // lifting a finger over a bar does not open that event.
      window.setTimeout(() => body.removeClass("is-pinching"), 250);
    };

    body.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size === 2) {
        startDist = spread();
        startZoom = this.filters.zoom ?? this.effectiveZoom;
        body.addClass("is-pinching");
      }
    });

    body.addEventListener("pointermove", (e: PointerEvent) => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size !== 2 || startDist <= 0) return;
      e.preventDefault();
      this.setZoom((startZoom * spread()) / startDist, startZoom, centre());
    });

    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
      body.addEventListener(ev, (e: Event) => {
        points.delete((e as PointerEvent).pointerId);
        endPinch();
      });
    }
  }
}

function applyFilters(events: TimelineEvent[], f: ViewFilters): TimelineEvent[] {
  // Delegate to the shared RichFilterState applicator so global view, inline
  // ```timeline blocks, and the single-event view share one filter
  // implementation. Keeps behaviour identical across views — no place for a
  // copy-paste bug to drift apart.
  const state: RichFilterState = {
    hiddenCategories: f.hiddenCategories,
    search: f.search,
    labels: f.labels,
    start: f.start,
    end: f.end,
    zoom: f.zoom,
  };
  return applyRichFilter(events, state);
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
    });
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
