import { ItemView, Platform, WorkspaceLeaf, type App } from "obsidian";
import type { TimelineXmlSyncSettings } from "../settings";
import type { TimelineCache } from "./cache";
import { renderTimeline } from "../renderer";
import { renderList } from "../renderer/list-renderer";
import { WindowedChart } from "../renderer/windowed-chart";
import type { TimelineDoc, TimelineEvent } from "../timeline/model";
import { type TimelineDate } from "../timeline/date";
import {
  applyRichFilter,
  distinctCategories,
  renderFilterBar,
  type RichFilterState,
} from "../renderer/filter-bar";
import {
  PinchTracker,
  ZOOM_STEP,
  clampZoom,
  maxZoomForAxis,
  focalScroll,
  formatZoom,
  wheelZoomFactor,
  type PinchAction,
  type PinchPoint,
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
  private zoomInEl: HTMLButtonElement | null = null;
  /** Windowed chart, when that path is enabled. Outlives filter changes. */
  private chart: WindowedChart | null = null;
  /** Framing the view opens with; what "Auto" returns to. */
  private autoZoom = 1;
  /**
   * Where the next render must land to keep the focal point still, expressed
   * as a fraction of the content rather than a pixel offset: the rendered axis
   * does not always grow by exactly the zoom ratio (the pixel cap, the auto
   * zoom and rounding all interfere), and assuming it did was what slid the
   * view sideways.
   */
  private pendingFocus: {
    fraction: number;
    focalPx: number;
    vertical: boolean;
  } | null = null;
  private zoomFrame: number | null = null;
  /** Live pinch/wheel gesture: scales the rendered SVG until the user lets go. */
  private preview: {
    scroller: HTMLElement;
    baseWidth: number;
    baseHeight: number;
    vertical: boolean;
    base: number;
    scale: number;
    startLeft: number;
    startTop: number;
    focalX: number;
    focalY: number;
  } | null = null;

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
    this.zoomInEl = zoomIn;
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
    if (this.args.getSettings().renderDefaults.windowedChart) {
      this.windowedRender(body);
      return;
    }
    const bodyScrollTop = body.scrollTop;
    const barScrolls: number[] = [];
    body.querySelectorAll<HTMLElement>(".txs-timeline-bar").forEach((b) => {
      barScrolls.push(b.scrollLeft);
    });

    if (!this.cachedDoc) {
      body.empty();
      return;
    }
    const { getSettings } = this.args;
    const settings = getSettings();

    let filtered = applyFilters(this.cachedDoc.events, this.filters);
    if (!filtered.length) {
      body.empty();
      body.createDiv({ text: "No events match current filters." });
      return;
    }

    // Build the new chart alongside the old one and swap in a single frame.
    // Emptying first left a blank pane for a frame, which reads as a flicker
    // when zooming. The staging div stays in the document (hidden, same
    // width) because the renderer sizes the chart from its container.
    const previous = Array.from(body.children);
    const staging = body.createDiv({ cls: "txs-view-staging" });

    const fullViewport = autoViewport(filtered);
    const computedZoom = pickAutoZoom(filtered.length, fullViewport, body);
    const autoZoom = this.filters.zoom != null ? this.filters.zoom : computedZoom;
    this.effectiveZoom = autoZoom;
    renderTimeline({
      container: staging,
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

    // Swap in two steps so there is never a blank frame: the new chart is
    // revealed as an overlay on top of the old one, and only once it has been
    // painted does the old one go away. A large SVG takes a moment to
    // rasterise, and removing the old nodes first is what let that show
    // through as a flash.
    const focus = this.pendingFocus;
    this.pendingFocus = null;

    const restore = () => {
      body.scrollTop = bodyScrollTop;
      body.querySelectorAll<HTMLElement>(".txs-timeline-bar").forEach((b, i) => {
        if (focus) {
          // Zoom: put the same slice of content back under the pointer,
          // measured against what was actually rendered.
          const size = focus.vertical ? b.scrollHeight : b.scrollWidth;
          const target = focus.fraction * size - focus.focalPx;
          if (focus.vertical) b.scrollTop = Math.max(0, target);
          else b.scrollLeft = Math.max(0, target);
        } else if (i < barScrolls.length) {
          b.scrollLeft = barScrolls[i];
        }
      });
    };

    // Swap in two steps so there is never a blank frame: the new chart is
    // revealed as an overlay on top of the old one, and only once it has been
    // painted does the old one go away. A large SVG takes a moment to
    // rasterise, and removing the old nodes first let that show through as a
    // flash.
    staging.removeClass("txs-view-staging");
    staging.addClass("txs-view-swapping");
    restore();

    window.requestAnimationFrame(() => {
      for (const el of previous) el.remove();
      staging.removeClass("txs-view-swapping");
      this.clearGestureState();
      restore();
      // Once more after layout has definitely settled.
      window.requestAnimationFrame(restore);
    });
  }

  /**
   * Windowed path (0.11): the chart draws only the time window on screen, so
   * zooming narrows the window instead of widening an SVG. The chart object
   * outlives a filter change — rebuilding it would throw away the scroll
   * position, i.e. jump to the start of the timeline on every chip toggle.
   */
  private windowedRender(body: HTMLElement): void {
    if (!this.cachedDoc) {
      body.empty();
      this.chart = null;
      return;
    }
    const settings = this.args.getSettings();
    const filtered = applyFilters(this.cachedDoc.events, this.filters);

    let host = body.querySelector<HTMLElement>(".txs-view-chart");
    let list = body.querySelector<HTMLElement>(".txs-view-list");
    if (!host || !list) {
      body.empty();
      host = body.createDiv({ cls: "txs-view-chart" });
      list = body.createDiv({ cls: "txs-view-list" });
      this.chart = null;
    }

    if (!filtered.length) {
      this.chart?.destroy();
      this.chart = null;
      host.empty();
      list.empty();
      list.createDiv({ text: "No events match current filters." });
      return;
    }

    const mode = settings.renderDefaults.mode;
    const wantsBar = mode === "bar" || mode === "hybrid";

    if (wantsBar) {
      if (!this.chart) {
        host.empty();
        this.chart = new WindowedChart({
          container: host,
          categories: this.cachedDoc.categories,
          categoryColors: settings.categoryColors,
          orientation: settings.renderDefaults.orientation,
          isMobile: Platform.isMobile,
          onOpenEvent: (id) => this.args.onEventClick(id),
          onOpenEra: (id) => this.args.onEraClick(id),
          fuzzyGradientPercent: settings.fuzzyGradientPercent,
          eventLabelColor: settings.eventLabelColor,
          stickyLabels: settings.renderDefaults.stickyLabels,
          onWindowChange: (_w, zoom) => {
            this.effectiveZoom = zoom;
            this.filters.zoom = zoom;
            this.updateZoomLabel();
          },
        });
      }
      const viewport = autoViewport(filtered) ?? {
        start: { year: 0 },
        end: { year: 1 },
      };
      this.autoZoom = pickAutoZoom(filtered.length, viewport, host);
      this.chart.setData(
        filtered,
        this.cachedDoc.eras ?? [],
        viewport,
        this.filters.zoom ?? this.autoZoom
      );
    } else {
      this.chart?.destroy();
      this.chart = null;
      host.empty();
    }

    list.empty();
    if (mode === "list" || mode === "hybrid") {
      renderList({
        container: list,
        events: filtered,
        options: {
          ...settings.renderDefaults,
          show: ["title", "date", "category"],
          details: "compact",
        },
        onOpenEvent: (id) => this.args.onEventClick(id),
        isMobile: Platform.isMobile,
        categoryColors: settings.categoryColors,
        eras: this.cachedDoc.eras,
        onOpenEra: (id) => this.args.onEraClick(id),
      });
    }
  }

  /** The horizontally (or vertically) scrolling box the bar chart lives in. */
  private barScroller(): HTMLElement | null {
    return this.contentEl.querySelector(".txs-timeline-bar");
  }

  private updateZoomLabel(): void {
    if (!this.zoomLabelEl) return;
    const z = this.filters.zoom;
    this.zoomLabelEl.textContent = z == null ? "Auto" : `${formatZoom(z)}×`;

    // At the ceiling the chart cannot grow further, so say so rather than
    // letting the number climb against a frozen view.
    const atMax = z != null && z >= this.maxZoom() - 0.001;
    if (this.zoomInEl) this.zoomInEl.disabled = atMax;
    this.zoomLabelEl.setAttr(
      "aria-label",
      atMax
        ? "Maximum zoom for this screen — tap to reset to automatic"
        : "Reset zoom to automatic"
    );
  }

  /**
   * Ceiling for this pane. The renderer caps the axis in pixels (and far more
   * tightly on mobile, where a huge layer takes the app down), so zoom past
   * this point would change the number and nothing else.
   */
  private maxZoom(): number {
    // Windowed, the ceiling comes from the data (a one-hour window), not from
    // how many pixels the platform will paint.
    if (this.chart) return this.chart.maxZoom;
    const body = this.contentEl.querySelector(".txs-view-body");
    const vertical =
      this.args.getSettings().renderDefaults.orientation === "vertical";
    // Mirrors the renderer's own floors for the axis base.
    const base = vertical
      ? Math.max(360, body?.clientHeight || 600)
      : Math.max(320, body?.clientWidth || 800);
    return maxZoomForAxis(base, Platform.isMobile);
  }

  /** Clamp that respects both the absolute limits and this pane's ceiling. */
  private clampForView(z: number): number {
    return Math.min(clampZoom(z), this.maxZoom());
  }

  /** Multiply the current zoom, keeping `focalClient` (px, viewport) steady. */
  private zoomBy(factor: number, focalClient?: { x: number; y: number }): void {
    if (this.chart) {
      // The windowed chart owns the window; it re-reports the zoom back to the
      // label through onWindowChange.
      this.chart.zoomBy(factor);
      return;
    }
    const from = this.filters.zoom ?? this.effectiveZoom;
    this.setZoom(from * factor, from, focalClient);
  }

  private setZoom(
    next: number,
    from: number,
    focalClient?: { x: number; y: number }
  ): void {
    const clamped = this.clampForView(next);
    if (Math.abs(clamped - from) < 0.001) return;

    const scroller = this.barScroller();
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      const vertical = scroller.hasClass("txs-vertical");
      const focalPx = focalClient
        ? vertical
          ? focalClient.y - rect.top
          : focalClient.x - rect.left
        : (vertical ? rect.height : rect.width) / 2;
      this.pendingFocus = focusFraction(scroller, vertical, focalPx);
    }

    this.filters.zoom = clamped;
    this.updateZoomLabel();
    this.scheduleZoomRender();
  }

  private resetZoom(): void {
    if (this.chart) {
      this.filters.zoom = null;
      this.chart.resetZoom(this.autoZoom);
      this.updateZoomLabel();
      return;
    }
    if (this.filters.zoom == null) return;
    this.filters.zoom = null;
    this.pendingFocus = null;
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
   * Pinch to zoom on touch, trackpad pinch / ctrl+wheel on desktop.
   *
   * Two deliberate choices, both learned the hard way:
   *
   * - Touch state comes from `event.touches` every time, never from a map of
   *   live pointer ids. A pointerup that never arrives (the WebView eats one
   *   when it takes over a scroll) leaves a stale id behind, and the next
   *   one-finger pan then looks like a pinch and zooms instead of scrolling.
   * - The gesture only transforms the existing SVG. Re-rendering it per frame
   *   costs far more than a frame budget on a phone, which is what made the
   *   view feel stuck. The real re-render happens once, on release.
   */
  private attachZoomGestures(body: HTMLElement): void {
    let wheelCommit: number | null = null;
    body.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        // A trackpad pinch arrives as a wheel event with ctrlKey set; plain
        // scrolling (including two-finger panning) must stay scrolling.
        if (!e.ctrlKey) return;
        e.preventDefault();
        const focal = { x: e.clientX, y: e.clientY };
        if (!this.preview) this.beginPreview(focal);
        this.updatePreview(
          (this.preview?.scale ?? 1) * wheelZoomFactor(e.deltaY),
          focal
        );
        if (wheelCommit != null) window.clearTimeout(wheelCommit);
        wheelCommit = window.setTimeout(() => {
          wheelCommit = null;
          this.commitPreview();
          // Long enough that a continuous trackpad pinch rebuilds the chart
          // once at the end rather than several times a second.
        }, 220);
      },
      { passive: false }
    );

    const pinch = new PinchTracker();

    body.addEventListener(
      "touchstart",
      (e: TouchEvent) => this.applyPinch(pinch.start(points(e))),
      { passive: true }
    );

    body.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        const action = pinch.move(points(e));
        if (action.kind === "update") e.preventDefault();
        this.applyPinch(action);
      },
      { passive: false }
    );

    const endPinch = (e: TouchEvent) => {
      this.applyPinch(pinch.end(points(e)));
      // Whatever the tracker thought, no fingers means no gesture: the
      // scroller must never be left with touch-action: none, or vertical
      // panning stays dead until the view is rebuilt.
      if (e.touches.length === 0) this.clearGestureState();
    };
    body.addEventListener("touchend", endPinch);
    body.addEventListener("touchcancel", endPinch);

    // Backgrounding the app can swallow the touchend entirely.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) {
        this.applyPinch(pinch.end([]));
        this.clearGestureState();
      }
    });
  }

  /** Drop every trace of an in-flight gesture. Safe to call at any time. */
  private clearGestureState(): void {
    this.contentEl
      .querySelectorAll<HTMLElement>(".txs-timeline-bar.is-scaling")
      .forEach((el) => {
        el.removeClass("is-scaling");
        el.setCssProps({
          "--txs-zoom-scale": "1",
          "--txs-zoom-inv": "1",
          "--txs-zoom-extra": "0px",
        });
      });
    this.contentEl.querySelector(".txs-view-body")?.removeClass("is-pinching");
  }

  private applyPinch(action: PinchAction): void {
    switch (action.kind) {
      case "begin":
        this.beginPreview(action.focal);
        break;
      case "update":
        this.updatePreview(action.scale, action.focal);
        break;
      case "commit":
        this.commitPreview();
        break;
      default:
        break;
    }
  }

  /** Snapshot what the gesture will scale, and freeze the scroll it started from. */
  private beginPreview(focalClient: { x: number; y: number }): void {
    const scroller = this.barScroller();
    const svg = scroller?.querySelector("svg") ?? null;
    if (!scroller || !svg) return;

    const rect = scroller.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    this.preview = {
      scroller,
      baseWidth: svgRect.width,
      baseHeight: svgRect.height,
      vertical: scroller.hasClass("txs-vertical"),
      base: this.filters.zoom ?? this.effectiveZoom,
      scale: 1,
      startLeft: scroller.scrollLeft,
      startTop: scroller.scrollTop,
      focalX: focalClient.x - rect.left,
      focalY: focalClient.y - rect.top,
    };
    // Bars stop taking taps for the duration, so ending a pinch over one
    // doesn't open that event.
    this.contentEl
      .querySelector(".txs-view-body")
      ?.addClass("is-pinching");
  }

  /** Live feedback: stretch the rendered SVG, no geometry recomputed. */
  private updatePreview(
    scale: number,
    focalClient: { x: number; y: number }
  ): void {
    const p = this.preview;
    if (!p) return;

    // Clamp against the zoom limits rather than the raw finger distance, so
    // the preview can never show something the commit won't reproduce.
    const target = this.clampForView(p.base * scale);
    p.scale = target / p.base;

    const rect = p.scroller.getBoundingClientRect();
    p.focalX = focalClient.x - rect.left;
    p.focalY = focalClient.y - rect.top;

    // The scale rides on custom properties; the transform itself lives in
    // styles.css, keyed off `is-scaling`. The extra length keeps the scroll
    // range honest while the gesture is in flight — a transform alone does
    // not grow the scroller's content, so zooming in would hit the old edge.
    const extra = p.vertical
      ? p.baseHeight * (p.scale - 1)
      : p.baseWidth * (p.scale - 1);
    p.scroller.addClass("is-scaling");
    p.scroller.setCssProps({
      "--txs-zoom-scale": String(p.scale),
      // Labels and point markers counter-scale by the inverse, so only the
      // bars stretch — text keeps its shape until the real render lands.
      "--txs-zoom-inv": String(1 / p.scale),
      "--txs-zoom-extra": `${Math.max(0, extra)}px`,
    });

    if (p.vertical) {
      p.scroller.scrollTop = focalScroll(p.startTop, p.focalY, p.scale);
    } else {
      p.scroller.scrollLeft = focalScroll(p.startLeft, p.focalX, p.scale);
    }
  }

  /** Drop the transform and re-render once, at the zoom the gesture landed on. */
  private commitPreview(): void {
    const p = this.preview;
    this.preview = null;
    if (!p) return;

    const next = this.clampForView(p.base * p.scale);
    if (Math.abs(next - p.base) < 0.001) {
      // Nothing changed; drop the preview and put the scroll back.
      this.clearGestureState();
      p.scroller.scrollLeft = p.startLeft;
      p.scroller.scrollTop = p.startTop;
      return;
    }

    // The stretched SVG stays on screen until the real one replaces it —
    // clearing it here would show one frame at the old zoom, which is exactly
    // the flicker. bodyRender() drops it as part of the swap.

    // Scroll is derived from where the gesture STARTED, so the preview's own
    // scrolling is not counted twice.
    // Anchor on the content fraction under the fingers, measured from where
    // the gesture STARTED so the preview's own scrolling is not counted twice.
    const focalPx = p.vertical ? p.focalY : p.focalX;
    const startScroll = p.vertical ? p.startTop : p.startLeft;
    const contentSize = p.vertical ? p.baseHeight : p.baseWidth;
    this.pendingFocus = {
      fraction: contentSize > 0 ? (startScroll + focalPx) / contentSize : 0,
      focalPx,
      vertical: p.vertical,
    };
    this.filters.zoom = next;
    this.updateZoomLabel();
    this.scheduleZoomRender();
  }
}

/** Fraction of the scroller's content sitting under `focalPx`. */
function focusFraction(
  scroller: HTMLElement,
  vertical: boolean,
  focalPx: number
): { fraction: number; focalPx: number; vertical: boolean } {
  const size = vertical ? scroller.scrollHeight : scroller.scrollWidth;
  const scroll = vertical ? scroller.scrollTop : scroller.scrollLeft;
  return {
    fraction: size > 0 ? (scroll + focalPx) / size : 0,
    focalPx,
    vertical,
  };
}

/** The touches currently down, in viewport coordinates. */
function points(e: TouchEvent): PinchPoint[] {
  return Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
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
