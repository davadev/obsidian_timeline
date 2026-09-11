import { fromJulian, toJulian, type TimelineDate } from "../timeline/date";

/**
 * Maps between a time window, a scroll position and the tiles that get drawn.
 *
 * The chart used to be one SVG spanning the whole timeline, widened by the zoom
 * factor — which on a long span became a compositing layer large enough for iOS
 * to kill the app. Here the drawn element stays pane-sized and the *window*
 * narrows instead, so zoom depth costs nothing.
 *
 * Everything is in Julian days (see `toJulian` / `fromJulian`), which are
 * monotone across BCE/CE and carry time of day in their fraction. No DOM.
 */

/** Narrowest window: one hour. */
export const MIN_WINDOW_DAYS = 1 / 24;

/**
 * Widest the virtual scroller's content is allowed to be.
 *
 * The spacer is empty, so this is not the layer problem the old renderer had —
 * measured fine in Blink up to 20M px — but iOS is unverified and the scroll
 * range has to stay somewhere sane. Past this the scroller represents a page of
 * the timeline rather than all of it.
 */
export const MAX_SCROLL_PX = 2_000_000;

export interface TimeWindow {
  /** Julian day of the left (or top) edge. */
  from: number;
  /** Julian day of the right (or bottom) edge. */
  to: number;
}

/** The full range the data covers; the window lives inside it. */
export interface TimeSpan {
  from: number;
  to: number;
}

/**
 * What the scroller currently represents. `from`/`to` are the slice of the
 * timeline it can reach; `px` is its content width.
 */
export interface ScrollPage {
  from: number;
  to: number;
  px: number;
}

export function spanOf(start: TimelineDate, end: TimelineDate): TimeSpan {
  return { from: toJulian(start), to: toJulian(end) };
}

export function windowDays(w: TimeWindow): number {
  return Math.max(MIN_WINDOW_DAYS, w.to - w.from);
}

export function spanDays(s: TimeSpan): number {
  return Math.max(MIN_WINDOW_DAYS, s.to - s.from);
}

/**
 * Zoom is the full span divided by what is visible — the same number the old
 * renderer used (axis width ÷ pane width), so `zoom: 4` in a note still means
 * "a quarter of the timeline is on screen".
 */
export function zoomOf(window: TimeWindow, span: TimeSpan): number {
  return spanDays(span) / windowDays(window);
}

/** Deepest zoom this data supports: the point where the window is one hour. */
export function maxZoomFor(span: TimeSpan): number {
  return spanDays(span) / MIN_WINDOW_DAYS;
}

export function clampZoomFor(zoom: number, span: TimeSpan): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(Math.max(zoom, 1), maxZoomFor(span));
}

/**
 * Window of `zoom` centred on `centre`, pushed inside the span if it would hang
 * over an edge. Zoom 1 is the whole span, which is also the widest allowed —
 * there is nothing to see beyond the data.
 */
export function windowFor(
  zoom: number,
  centre: number,
  span: TimeSpan
): TimeWindow {
  const days = spanDays(span) / clampZoomFor(zoom, span);
  const half = days / 2;
  let from = centre - half;
  if (from < span.from) from = span.from;
  if (from + days > span.to) from = span.to - days;
  if (from < span.from) from = span.from; // window wider than the span
  return { from, to: from + days };
}

/** Same window, re-anchored inside a span that has changed under it. */
export function clampWindow(w: TimeWindow, span: TimeSpan): TimeWindow {
  return windowFor(zoomOf(w, span), (w.from + w.to) / 2, span);
}

/**
 * The page of the timeline the scroller represents.
 *
 * Below `MAX_SCROLL_PX` that is the whole span. Above it — an hour-deep window
 * on a six-millennia timeline would want ~2×10^10 px — the page is a slice
 * around the window, and crossing its edge re-anchors it (see `needsRepage`).
 */
export function pageFor(
  window: TimeWindow,
  span: TimeSpan,
  paneW: number,
  maxPx = MAX_SCROLL_PX
): ScrollPage {
  const pane = Math.max(1, paneW);
  const visible = windowDays(window);
  const wanted = (spanDays(span) / visible) * pane;
  if (wanted <= maxPx) {
    return { from: span.from, to: span.to, px: Math.max(pane, wanted) };
  }

  // Widest slice of time that still fits the pixel budget, centred on the
  // window and pushed inside the span.
  const pageDays = (maxPx / pane) * visible;
  const centre = (window.from + window.to) / 2;
  let from = centre - pageDays / 2;
  if (from < span.from) from = span.from;
  if (from + pageDays > span.to) from = span.to - pageDays;
  if (from < span.from) from = span.from;
  return { from, to: from + pageDays, px: maxPx };
}

/** Scroll offset that puts `window` at the left edge of the viewport. */
export function windowToScroll(
  window: TimeWindow,
  page: ScrollPage,
  paneW: number
): number {
  const pageDays = Math.max(MIN_WINDOW_DAYS, page.to - page.from);
  const max = Math.max(0, page.px - Math.max(1, paneW));
  const at = ((window.from - page.from) / pageDays) * page.px;
  return Math.min(Math.max(0, at), max);
}

/** The window a scroll offset selects. */
export function scrollToWindow(
  scrollPx: number,
  page: ScrollPage,
  paneW: number,
  visibleDays: number
): TimeWindow {
  const pane = Math.max(1, paneW);
  const pageDays = Math.max(MIN_WINDOW_DAYS, page.to - page.from);
  const perPx = pageDays / page.px;
  const from = page.from + Math.max(0, scrollPx) * perPx;
  const days = Math.max(MIN_WINDOW_DAYS, visibleDays || pane * perPx);
  return { from, to: from + days };
}

/**
 * True when the scroll has come close enough to an end of a paged scroller that
 * the page has to be re-anchored around the window. Only meaningful while the
 * page is a slice — a page covering the whole span has nowhere to move.
 */
export function needsRepage(
  scrollPx: number,
  page: ScrollPage,
  span: TimeSpan,
  paneW: number,
  edgeFraction = 0.1
): boolean {
  if (page.from <= span.from && page.to >= span.to) return false;
  const pane = Math.max(1, paneW);
  const usable = Math.max(1, page.px - pane);
  const edge = usable * edgeFraction;
  const atStart = scrollPx <= edge && page.from > span.from;
  const atEnd = scrollPx >= usable - edge && page.to < span.to;
  return atStart || atEnd;
}

/**
 * Tiles are fixed-width slices of the page, so panning moves over content that
 * already exists rather than waiting for a draw. `index` is stable for a given
 * page, which is what lets the ring keep tiles across scrolls.
 */
export interface Tile {
  index: number;
  /** Offset of the tile inside the scroller, in px. */
  px: number;
  from: number;
  to: number;
}

export function tileAt(
  index: number,
  page: ScrollPage,
  paneW: number
): Tile {
  const pane = Math.max(1, paneW);
  const pageDays = Math.max(MIN_WINDOW_DAYS, page.to - page.from);
  const perPx = pageDays / page.px;
  const px = index * pane;
  return {
    index,
    px,
    from: page.from + px * perPx,
    to: page.from + (px + pane) * perPx,
  };
}

/**
 * Indices the ring should hold for a scroll position: the visible tile plus
 * `radius` either side, clipped to the page.
 */
export function tileRange(
  scrollPx: number,
  page: ScrollPage,
  paneW: number,
  radius = 2
): number[] {
  const pane = Math.max(1, paneW);
  const last = Math.max(0, Math.ceil(page.px / pane) - 1);
  const centre = Math.min(last, Math.max(0, Math.floor(scrollPx / pane)));
  const out: number[] = [];
  for (let i = centre - radius; i <= centre + radius; i++) {
    if (i >= 0 && i <= last) out.push(i);
  }
  return out;
}

/** Dates for a window, for callers that need them (axis, era filtering). */
export function windowDates(w: TimeWindow): { start: TimelineDate; end: TimelineDate } {
  return { start: fromJulian(w.from), end: fromJulian(w.to) };
}
