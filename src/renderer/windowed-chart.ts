import type { TimelineCategory, TimelineEra, TimelineEvent } from "../timeline/model";
import { assignLanes } from "../timeline/overlap";
import { fromJulian, toJulian } from "../timeline/date";
import { crossAxisSizeFor, drawViewportLabel, renderBar } from "./bar-renderer";
import type { Orientation } from "./render-options";
import {
  PinchTracker,
  ZOOM_STEP,
  wheelZoomFactor,
  type PinchPoint,
} from "./zoom-math";
import {
  clampWindow,
  clampZoomFor,
  maxZoomFor,
  needsRepage,
  pageFor,
  scrollToWindow,
  spanOf,
  tileAt,
  tileRange,
  windowDays,
  windowFor,
  windowToScroll,
  zoomOf,
  type ScrollPage,
  type TimeSpan,
  type TimeWindow,
} from "./time-window";

/**
 * The windowed chart.
 *
 * The old renderer drew the entire timeline into one SVG and let the zoom
 * factor widen it, which on a long span produced a compositing layer large
 * enough for iOS to kill the app. Here the drawn content is always about the
 * size of the pane: an empty spacer gives the scroller its range, and the chart
 * is a ring of pane-wide tiles positioned inside it.
 *
 * Consequences worth knowing:
 * - An ordinary scroll frame runs no JavaScript. Tiles already exist; native
 *   scrolling moves them.
 * - Tiles ahead of and behind the viewport are built in advance, so a fast
 *   flick moves over content that is already there.
 * - Zoom narrows the window instead of stretching anything, so depth is free.
 */

export interface WindowedChartArgs {
  container: HTMLElement;
  categories: TimelineCategory[];
  categoryColors: Record<string, string>;
  orientation: Orientation;
  isMobile: boolean;
  onOpenEvent: (id: string) => void;
  onOpenEra?: (eraId: string) => void;
  fuzzyGradientPercent?: number;
  eventLabelColor?: string;
  stickyLabels?: boolean;
  /** Fired whenever the visible window changes, for the zoom readout. */
  onWindowChange?: (window: TimeWindow, zoom: number, maxZoom: number) => void;
}

/** How many tiles either side of the visible one are kept ready. */
const TILE_RADIUS = 2;

/**
 * Exponent applied to a pinch's scale.
 *
 * Fingers can only travel so far: one pinch spans maybe 2-3x, which is nothing
 * against a zoom range that runs to millions. Raising the scale to a power
 * means one comfortable gesture covers an order of magnitude, the way a map
 * behaves, instead of needing a dozen pinches to get anywhere.
 */
const PINCH_GAIN = 2.5;

/** Safety net: clear a stuck pinch state if the gesture's end never arrives. */
const PINCH_WATCHDOG_MS = 600;

export class WindowedChart {
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  /** Pinned to the viewport; holds every label the chart shows. */
  private readonly edgeLayer: HTMLElement;
  private edgeSvg: SVGSVGElement | null = null;
  private readonly tiles = new Map<number, HTMLElement>();
  private readonly resize: ResizeObserver | null = null;
  private readonly pinch = new PinchTracker();

  private events: TimelineEvent[] = [];
  private eras: TimelineEra[] = [];
  private laneByEventId = new Map<string, number>();
  private laneCount = 1;
  private span: TimeSpan = { from: 0, to: 1 };
  window: TimeWindow = { from: 0, to: 1 };
  page: ScrollPage = { from: 0, to: 1, px: 1 };
  private paneW = 1;
  private syncing = false;
  private frame: number | null = null;
  private zoomFrame: number | null = null;
  /** Set once WebKit sends a real pinch, so the touch fallback stands down. */
  private webkitGestures = false;
  private pinchWatchdog: number | null = null;
  private pendingZoom: { zoom: number; focalPx: number } | null = null;

  constructor(private args: WindowedChartArgs) {
    this.scroller = args.container.createDiv({ cls: "txs-chart" });
    this.scroller.toggleClass("txs-vertical", this.vertical);
    // Order matters: a sticky element can only be pushed FORWARD from where it
    // would naturally sit, so the edge layer has to flow before the spacer or
    // it would be pinned somewhere off the end of the timeline. Zero-sized, so
    // it takes no part in the scroll content.
    this.edgeLayer = this.scroller.createDiv({ cls: "txs-chart-edge" });
    this.spacer = this.scroller.createDiv({ cls: "txs-chart-spacer" });

    this.scroller.addEventListener("scroll", () => this.onScroll(), {
      passive: true,
    });
    this.attachGestures();

    if (typeof ResizeObserver !== "undefined") {
      // Pane size is half of the scroll-to-time mapping: without this, rotating
      // a phone or opening a sidebar would scroll you to the wrong date.
      this.resize = new ResizeObserver(() => this.onResize());
      this.resize.observe(this.scroller);
    }
  }

  private get vertical(): boolean {
    return this.args.orientation === "vertical";
  }

  private measurePane(): number {
    const px = this.vertical
      ? this.scroller.clientHeight
      : this.scroller.clientWidth;
    return Math.max(1, px || this.paneW);
  }

  /** Replace the data. Keeps the window where it is, clamped to the new span. */
  setData(
    events: TimelineEvent[],
    eras: TimelineEra[],
    span: { start: { year: number }; end: { year: number } } | TimeSpan,
    initialZoom?: number
  ): void {
    this.events = events;
    this.eras = eras;

    // Lanes are assigned once across everything on screen, never per tile:
    // per-tile assignment would move a bar to another row as you pan.
    const lanes = assignLanes(events);
    this.laneByEventId = new Map();
    events.forEach((e, i) => this.laneByEventId.set(e.id, lanes[i]));
    this.laneCount = Math.max(1, ...lanes.map((l) => l + 1));

    const next: TimeSpan = "from" in span ? span : spanOf(span.start, span.end);
    const first = this.span.to - this.span.from <= 1;
    this.span = next;
    this.paneW = this.measurePane();

    this.window = first
      ? windowFor(clampZoomFor(initialZoom ?? 1, next), midpoint(next), next)
      : clampWindow(this.window, next);

    this.rebuild(true);
  }

  /** Current zoom, for the caller's readout. */
  get zoom(): number {
    return zoomOf(this.window, this.span);
  }

  get maxZoom(): number {
    return maxZoomFor(this.span);
  }

  /** Multiply the zoom, keeping `focalPx` (px inside the pane) on the same date. */
  zoomBy(factor: number, focalPx?: number): void {
    // Compose against whatever is already queued: two wheel notches in one
    // frame have to multiply, not overwrite each other.
    const base = this.pendingZoom?.zoom ?? this.zoom;
    this.zoomTo(base * factor, focalPx);
  }

  /**
   * Zoom to an absolute factor, coalesced to one rebuild per frame.
   *
   * A pinch fires touchmove far faster than a chart can be rebuilt, and each
   * rebuild also re-seeks the scroller — doing that per event made the gesture
   * fight itself and crawl.
   */
  zoomTo(zoom: number, focalPx?: number): void {
    this.pendingZoom = {
      zoom: clampZoomFor(zoom, this.span),
      focalPx: focalPx ?? this.paneW / 2,
    };
    if (this.zoomFrame != null) return;
    this.zoomFrame = window.requestAnimationFrame(() => {
      this.zoomFrame = null;
      const next = this.pendingZoom;
      this.pendingZoom = null;
      if (!next) return;

      const at = next.focalPx;
      const dateUnderPointer =
        this.window.from + (at / this.paneW) * windowDays(this.window);
      const days = (this.span.to - this.span.from) / next.zoom;
      // Put that date back where it was rather than centring on it.
      const centre = dateUnderPointer + (0.5 - at / this.paneW) * days;

      this.window = windowFor(next.zoom, centre, this.span);
      this.rebuild(true);
    });
  }

  /** Back to the framing the view opened with. */
  resetZoom(initialZoom = 1): void {
    this.window = windowFor(
      clampZoomFor(initialZoom, this.span),
      midpoint(this.span),
      this.span
    );
    this.rebuild(true);
  }

  destroy(): void {
    this.releasePinch();
    this.resize?.disconnect();
    if (this.frame != null) window.cancelAnimationFrame(this.frame);
    this.scroller.remove();
  }

  // ---------------------------------------------------------------- internals

  /** Recompute the page and spacer, then draw the tiles the viewport needs. */
  private rebuild(syncScroll: boolean): void {
    this.paneW = this.measurePane();
    this.page = pageFor(this.window, this.span, this.paneW);

    // The spacer carries BOTH axes: its scroll-axis length gives the scroller
    // its range, and its cross-axis size gives the scroller its height —
    // absolutely positioned tiles contribute neither.
    const along = `${Math.round(this.page.px)}px`;
    const across = `${crossAxisSizeFor(this.laneCount)}px`;
    if (this.vertical) this.spacer.setCssProps({ height: along, width: across });
    else this.spacer.setCssProps({ width: along, height: across });

    if (syncScroll) {
      const at = windowToScroll(this.window, this.page, this.paneW);
      this.syncing = true;
      if (this.vertical) this.scroller.scrollTop = at;
      else this.scroller.scrollLeft = at;
      // The scroll event this triggers must not be read as the user panning.
      window.setTimeout(() => (this.syncing = false), 0);
      // Tiles are indexed against the page, so a new page invalidates them.
      this.dropAllTiles();
    }

    this.paintTiles();
    this.paintEdgeLabels();
    this.args.onWindowChange?.(this.window, this.zoom, this.maxZoom);
  }

  /**
   * Every label the chart shows, drawn once, in viewport coordinates.
   *
   * Tiles deliberately draw none: a bar crossing a seam would otherwise be
   * labelled by each tile it touches, and a bar whose start had just scrolled
   * off would show its own label overlapping the one sliding in behind it.
   * Here a label slides along the visible part of its bar and there is nothing
   * to collide with.
   */
  private paintEdgeLabels(): void {
    const cross = crossAxisSizeFor(this.laneCount);
    if (!this.edgeSvg) {
      this.edgeSvg = this.edgeLayer.createSvg("svg");
    }
    const svg = this.edgeSvg;
    const along = this.vertical ? cross : this.paneW;
    const across = this.vertical ? this.paneW : cross;
    svg.setAttribute("width", String(this.vertical ? along : this.paneW));
    svg.setAttribute("height", String(this.vertical ? this.paneW : cross));
    svg.setAttribute(
      "viewBox",
      `0 0 ${this.vertical ? along : this.paneW} ${this.vertical ? this.paneW : across}`
    );
    svg.replaceChildren();

    const perPx = windowDays(this.window) / Math.max(1, this.paneW);
    for (const ev of this.events) {
      if (ev.isPoint) continue; // points carry no label
      const from = toJulian(ev.start);
      const to = toJulian(ev.end);
      if (to <= this.window.from || from >= this.window.to) continue; // off-screen
      drawViewportLabel(svg, ev, {
        lane: this.laneByEventId.get(ev.id) ?? 0,
        startPx: (from - this.window.from) / perPx,
        endPx: (to - this.window.from) / perPx,
        paneSize: this.paneW,
        isVertical: this.vertical,
        categoryColors: this.args.categoryColors,
        labelColorOverride: this.args.eventLabelColor,
      });
    }
  }

  private onScroll(): void {
    if (this.syncing) return;
    if (this.frame != null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      const at = this.scrollPos();
      this.window = scrollToWindow(
        at,
        this.page,
        this.paneW,
        windowDays(this.window)
      );

      if (needsRepage(at, this.page, this.span, this.paneW)) {
        // Ran off the end of a paged scroller: re-anchor around what is on
        // screen. The dates under the viewport stay put; only the scrollbar
        // jumps, which is the price of an hour-deep zoom on a long timeline.
        this.rebuild(true);
        return;
      }

      this.paintTiles();
      this.paintEdgeLabels();
      this.args.onWindowChange?.(this.window, this.zoom, this.maxZoom);
    });
  }

  private onResize(): void {
    const next = this.measurePane();
    if (next === this.paneW) return;
    // Keep the same slice of time on screen at the new size.
    const zoom = this.zoom;
    this.paneW = next;
    this.window = windowFor(zoom, midpoint(this.window), this.span);
    this.rebuild(true);
  }

  /**
   * Suspends native panning while two fingers are down, so the WebView cannot
   * claim the gesture. Self-releasing: if the gesture's end is swallowed, the
   * watchdog restores panning rather than leaving the chart unscrollable.
   */
  private holdPinch(): void {
    this.scroller.addClass("is-pinching");
    if (this.pinchWatchdog != null) window.clearTimeout(this.pinchWatchdog);
    this.pinchWatchdog = window.setTimeout(
      () => this.releasePinch(),
      PINCH_WATCHDOG_MS
    );
  }

  private releasePinch(): void {
    if (this.pinchWatchdog != null) {
      window.clearTimeout(this.pinchWatchdog);
      this.pinchWatchdog = null;
    }
    this.scroller.removeClass("is-pinching");
  }

  private scrollPos(): number {
    return this.vertical ? this.scroller.scrollTop : this.scroller.scrollLeft;
  }

  private dropAllTiles(): void {
    for (const el of this.tiles.values()) el.remove();
    this.tiles.clear();
  }

  /** Build whatever the ring is missing and drop whatever left it. */
  private paintTiles(): void {
    const wanted = tileRange(this.scrollPos(), this.page, this.paneW, TILE_RADIUS);
    const keep = new Set(wanted);

    for (const [index, el] of this.tiles) {
      if (!keep.has(index)) {
        el.remove();
        this.tiles.delete(index);
      }
    }
    for (const index of wanted) {
      if (!this.tiles.has(index)) this.tiles.set(index, this.buildTile(index));
    }
  }

  private buildTile(index: number): HTMLElement {
    const tile = tileAt(index, this.page, this.paneW);
    const start = fromJulian(tile.from);
    const end = fromJulian(tile.to);

    // Only what this tile covers, plus anything overlapping its edges.
    const events = this.events.filter(
      (e) => toJulian(e.end) >= tile.from && toJulian(e.start) <= tile.to
    );
    const eras = this.eras.filter(
      (e) => toJulian(e.end) >= tile.from && toJulian(e.start) <= tile.to
    );

    const host = this.scroller.createDiv({ cls: "txs-tile-host" });
    host.setCssProps(
      this.vertical
        ? { top: `${Math.round(tile.px)}px`, left: "0px" }
        : { left: `${Math.round(tile.px)}px`, top: "0px" }
    );

    renderBar({
      container: host,
      events,
      categories: this.args.categories,
      viewport: { start, end },
      categoryColors: this.args.categoryColors,
      onOpenEvent: this.args.onOpenEvent,
      zoom: 1,
      orientation: this.args.orientation,
      isMobile: this.args.isMobile,
      eras,
      onOpenEra: this.args.onOpenEra,
      fuzzyGradientPercent: this.args.fuzzyGradientPercent,
      eventLabelColor: this.args.eventLabelColor,
      stickyLabels: this.args.stickyLabels,
      tile: {
        axisPx: this.paneW,
        laneByEventId: this.laneByEventId,
        laneCount: this.laneCount,
      },
    });
    return host;
  }

  private attachGestures(): void {
    this.scroller.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        // A trackpad pinch arrives as ctrl+wheel; plain scrolling stays scrolling.
        if (!e.ctrlKey) return;
        e.preventDefault();
        const rect = this.scroller.getBoundingClientRect();
        const at = this.vertical ? e.clientY - rect.top : e.clientX - rect.left;
        this.zoomBy(wheelZoomFactor(e.deltaY), at);
      },
      { passive: false }
    );

    // WebKit (and so Obsidian on iOS) reports a pinch as its own gesture
    // events, with `scale` relative to the start of the gesture. Those are the
    // ones to use: `touch-action` is latched when a touch sequence begins, so
    // switching it off once a second finger lands is too late — the WebView has
    // already claimed the gesture for panning, which is why a pinch only ever
    // nudged the zoom.
    // Both are attached. Gesture events are not guaranteed — a page that
    // disables user scaling can stop WebKit emitting them — so the touch path
    // stays as a fallback and stands down the moment a real gesture event
    // arrives, rather than the two fighting over the same fingers.
    if ("ongesturestart" in window) this.attachWebKitGestures();
    this.attachTouchGestures();
  }

  private attachWebKitGestures(): void {
    let startZoom = 1;
    let focal = 0;

    const at = (e: Event): number => {
      const rect = this.scroller.getBoundingClientRect();
      const g = e as unknown as { clientX?: number; clientY?: number };
      return this.vertical
        ? (g.clientY ?? rect.top + rect.height / 2) - rect.top
        : (g.clientX ?? rect.left + rect.width / 2) - rect.left;
    };

    // Note: no touch-action juggling here. WebKit's own gesture events already
    // suppress the browser's pinch, and turning panning off would leave the
    // scroller dead if the gesture's end never arrived — which is what broke
    // scrolling after a zoom.
    this.scroller.addEventListener("gesturestart", (e: Event) => {
      e.preventDefault();
      this.webkitGestures = true;
      startZoom = this.zoom;
      focal = at(e);
    });

    this.scroller.addEventListener("gesturechange", (e: Event) => {
      e.preventDefault();
      const scale = (e as unknown as { scale?: number }).scale ?? 1;
      if (scale > 0) this.zoomTo(startZoom * Math.pow(scale, PINCH_GAIN), focal);
    });

    this.scroller.addEventListener("gestureend", (e: Event) => e.preventDefault());
  }

  private attachTouchGestures(): void {


    const points = (e: TouchEvent): PinchPoint[] =>
      Array.from(e.touches, (t) => ({ x: t.clientX, y: t.clientY }));
    let startZoom = 1;

    this.scroller.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (this.webkitGestures) return;
        const action = this.pinch.start(points(e));
        if (action.kind === "begin") {
          startZoom = this.zoom;
          this.holdPinch();
        }
      },
      { passive: true }
    );

    this.scroller.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (this.webkitGestures) return;
        const action = this.pinch.move(points(e));
        if (action.kind !== "update") return;
        e.preventDefault();
        const rect = this.scroller.getBoundingClientRect();
        const at = this.vertical
          ? action.focal.y - rect.top
          : action.focal.x - rect.left;
        // Absolute, from where the gesture started: relative steps would
        // compound rounding across a long pinch.
        this.holdPinch();
        this.zoomTo(startZoom * Math.pow(action.scale, PINCH_GAIN), at);
      },
      { passive: false }
    );

    const end = (e: TouchEvent) => {
      // Release the hold whatever the tracker thinks: a scroller left with
      // touch-action: none cannot be panned at all.
      if (e.touches.length === 0) this.releasePinch();
      if (this.webkitGestures) return;
      this.pinch.end(points(e));
    };
    this.scroller.addEventListener("touchend", end);
    this.scroller.addEventListener("touchcancel", end);
  }
}

function midpoint(range: { from: number; to: number }): number {
  return (range.from + range.to) / 2;
}

/** One press of +/-, exported so the caller's buttons agree with the pinch. */
export const CHART_ZOOM_STEP = ZOOM_STEP;
