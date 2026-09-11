import type { TimelineCategory, TimelineEra, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { assignLanes } from "../timeline/overlap";
import { fractionalPosition } from "../timeline/date";
import { hideTooltip, showTooltip } from "./tooltip";
import { clampAxisSize } from "./zoom-math";
import { visibleAxisTicks } from "./axis-ticks";
import type { Orientation } from "./render-options";

/**
 * SVG bar renderer that supports two orientations:
 *
 * - horizontal: time runs left→right, lanes stack top↓bottom. SVG width grows
 *   with the zoom factor and the wrapper allows horizontal scrolling.
 * - vertical: time runs top→bottom, lanes are columns running left→right.
 *   SVG height grows with the zoom factor and the wrapper scrolls vertically.
 *   Labels on bars are rendered rotated 90° so they remain readable; tooltips
 *   and mobile panels stay horizontal.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const LANE_THICKNESS = 26; // height (horizontal) or width (vertical) of one lane
const LANE_GAP = 6;
const AXIS_PAD = 34; // padding before first lane that holds axis labels
const TAIL_PAD = 10;
const POINT_RADIUS = 6;
const LABEL_PAD = 8;
const CHAR_W = 6.5;
const MIN_BAR_THICKNESS = 4;

export interface BarRenderArgs {
  container: HTMLElement;
  events: TimelineEvent[];
  categories: TimelineCategory[];
  viewport: ViewportRange | undefined;
  categoryColors: Record<string, string>;
  onOpenEvent: (id: string) => void;
  zoom: number;
  orientation: Orientation;
  /** Explicit mobile flag from the caller (Platform.isMobile). Touch-capability
   * sniffing is unreliable on macOS where Electron reports maxTouchPoints>0
   * which previously disabled hover tooltips on the desktop. */
  isMobile: boolean;
  /** Optional eras to paint as coloured background bands under all events. */
  eras?: TimelineEra[];
  /** Click handler for era bands / labels. */
  onOpenEra?: (eraId: string) => void;
  /** Percent of bar length the fuzzy-edge gradient fades over. Default 20. */
  fuzzyGradientPercent?: number;
  /** CSS color for event labels. Empty/undefined = auto-contrast vs. fill. */
  eventLabelColor?: string;
  /** Slide labels along their bar so they stay visible. Default on. */
  stickyLabels?: boolean;
}

export function renderBar(args: BarRenderArgs): HTMLElement {
  const {
    container,
    events,
    viewport,
    categoryColors,
    onOpenEvent,
    zoom,
    orientation,
  } = args;
  const wrapper = container.createDiv({ cls: "txs-timeline-bar" });
  if (!viewport || events.length === 0) {
    wrapper.createDiv({ text: "No events to display." });
    return wrapper;
  }
  const isVertical = orientation === "vertical";
  wrapper.toggleClass("txs-vertical", isVertical);
  const gradientPercent = clampPercent(args.fuzzyGradientPercent ?? 20);
  const labelColorOverride =
    args.eventLabelColor && args.eventLabelColor.trim()
      ? args.eventLabelColor.trim()
      : null;

  // Labels that should slide along their bar while it is scrolled.
  const sticky: StickyLabel[] = [];

  const lanes = assignLanes(events);
  const laneCount = Math.max(1, ...lanes.map((l) => l + 1));

  const containerSize = isVertical
    ? Math.max(280, container.clientWidth || 640)
    : Math.max(320, container.clientWidth || 800);
  // Time-axis size grows with zoom; cross-axis is laneCount-derived.
  const timeAxisBase = isVertical
    ? Math.max(360, container.clientHeight || 600)
    : containerSize;
  const timeAxisSize = clampAxisSize(timeAxisBase * zoom);
  const crossAxisSize =
    AXIS_PAD + laneCount * (LANE_THICKNESS + LANE_GAP) + TAIL_PAD;

  const width = isVertical ? crossAxisSize : timeAxisSize;
  const height = isVertical ? timeAxisSize : crossAxisSize;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const defs = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(defs);
  const gradientId = makeGradientIdFactory();
  // iOS WebView (Obsidian Mobile) resolves `fill="url(#id)"` against the
  // document's <base href> rather than the SVG itself, which silently turns
  // the fill into "not found" and paints the shape with its default (none /
  // black depending on element). Prefixing the fragment with the current
  // location forces same-document resolution and is a no-op on desktop.
  const fragmentBase = makeFragmentBase();

  // Eras paint FIRST so they sit behind stripes + axis grid + events.
  if (args.eras && args.eras.length) {
    drawEras(svg, args.eras, viewport, isVertical, width, height, args.onOpenEra);
  }
  drawLaneStripes(svg, laneCount, isVertical, width, height);
  const paintAxis = drawAxis(svg, viewport, isVertical, width, height);

  const isMobile = args.isMobile;

  events.forEach((ev, i) => {
    const lane = lanes[i];
    const cross = AXIS_PAD + lane * (LANE_THICKNESS + LANE_GAP);
    const color = colorFor(ev, categoryColors);
    const textColor = labelColorOverride ?? contrastTextColor(color);
    if (ev.isPoint) {
      const along =
        fractionalPosition(ev.start, viewport.start, viewport.end) *
        timeAxisSize;
      const cx = isVertical ? cross + LANE_THICKNESS / 2 : along;
      const cy = isVertical ? along : cross + LANE_THICKNESS / 2;
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", "0");
      circle.setAttribute("cy", "0");
      circle.setAttribute("r", String(POINT_RADIUS));
      const pointFuzzy = ev.fuzzyStart === true || ev.fuzzyEnd === true || ev.fuzzy === true;
      if (pointFuzzy) {
        const id = gradientId();
        defs.appendChild(makeRadialFuzzyGradient(id, color, gradientPercent));
        circle.setAttribute("fill", `url(${fragmentBase}#${id})`);
      } else {
        circle.setAttribute("fill", color);
      }
      circle.setAttribute("stroke", "var(--background-primary)");
      circle.setAttribute("stroke-width", "1");
      circle.classList.add("txs-event-point");
      attachEvents(circle, ev, container, onOpenEvent, isMobile);
      anchored(svg, circle, cx, cy);
    } else {
      const a1 =
        fractionalPosition(ev.start, viewport.start, viewport.end) *
        timeAxisSize;
      const a2 =
        fractionalPosition(ev.end, viewport.start, viewport.end) * timeAxisSize;
      const span = Math.max(MIN_BAR_THICKNESS, a2 - a1);
      const rect = document.createElementNS(SVG_NS, "rect");
      if (isVertical) {
        rect.setAttribute("x", String(cross));
        rect.setAttribute("y", String(a1));
        rect.setAttribute("width", String(LANE_THICKNESS));
        rect.setAttribute("height", String(span));
      } else {
        rect.setAttribute("x", String(a1));
        rect.setAttribute("y", String(cross));
        rect.setAttribute("width", String(span));
        rect.setAttribute("height", String(LANE_THICKNESS));
      }
      rect.setAttribute("rx", "4");
      rect.setAttribute("ry", "4");
      const fuzzyStart = ev.fuzzyStart === true || (ev.fuzzy === true && ev.fuzzyEnd !== false);
      const fuzzyEnd = ev.fuzzyEnd === true || (ev.fuzzy === true && ev.fuzzyStart !== false);
      if (fuzzyStart || fuzzyEnd) {
        const id = gradientId();
        defs.appendChild(
          makeLinearFuzzyGradient(
            id,
            color,
            fuzzyStart,
            fuzzyEnd,
            isVertical,
            gradientPercent
          )
        );
        rect.setAttribute("fill", `url(${fragmentBase}#${id})`);
      } else {
        rect.setAttribute("fill", color);
      }
      rect.classList.add("txs-event-bar");
      attachEvents(rect, ev, container, onOpenEvent, isMobile);
      svg.appendChild(rect);

      const maxChars = Math.floor((span - LABEL_PAD * 2) / CHAR_W);
      if (maxChars >= 4) {
        const label = document.createElementNS(SVG_NS, "text");
        const text = truncate(ev.text, maxChars);
        // The gap lives on the text, not on the anchor: inside the
        // counter-scaled child it keeps its pixel width through a pinch,
        // whereas an anchor offset would stretch with the bar.
        label.setAttribute("x", String(LABEL_PAD));
        label.setAttribute("y", "0");
        if (isVertical) label.setAttribute("text-anchor", "start");
        label.setAttribute("class", "txs-event-label");
        label.setAttribute("fill", textColor);
        label.textContent = text;
        const group = isVertical
          ? anchored(svg, label, cross + LANE_THICKNESS / 2, a1, 90)
          : anchored(svg, label, a1, cross + LANE_THICKNESS / 2);
        if (args.stickyLabels !== false) {
          sticky.push({
            g: group,
            from: a1,
            to: a2,
            cross: cross + LANE_THICKNESS / 2,
            width: text.length * CHAR_W + LABEL_PAD * 2,
            at: a1,
          });
        }
      }
    }
  });

  wrapper.appendChild(svg);
  attachViewportPainters(wrapper, isVertical, paintAxis, sticky);
  return wrapper;
}

/**
 * Puts `child` at its anchor point via a wrapping <g translate(...)>, leaving
 * the child itself at the local origin.
 *
 * That is what lets the pinch preview counter-scale labels and point markers
 * about their own anchor: the ancestor transform moves the group with the
 * bars, while the child's own scale has an origin that sits exactly on the
 * anchor, so nothing drifts sideways.
 */
function anchored(
  parent: SVGElement,
  child: SVGElement,
  x: number,
  y: number,
  rotateDeg = 0
): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  const rotate = rotateDeg ? ` rotate(${rotateDeg})` : "";
  g.setAttribute("transform", `translate(${x} ${y})${rotate}`);
  g.appendChild(child);
  parent.appendChild(g);
  return g;
}

function attachEvents(
  el: SVGElement,
  ev: TimelineEvent,
  container: HTMLElement,
  onOpen: (id: string) => void,
  isMobile: boolean
): void {
  // Always route through the plugin's click router (inspector or open-note).
  // We only listen for "click" — iOS's synthetic click event is already
  // suppressed when the user is panning/scrolling, so a drag across the bar
  // no longer triggers the inspector. A separate touchend listener we used
  // to have was the source of the "scrolling accidentally opens events" bug
  // on dense timelines.
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpen(ev.id);
  });
  // Hit-target affordance + suppress the iOS 300ms tap delay.
  el.classList.add("txs-bar-hit");

  if (!isMobile) {
    el.addEventListener("mouseenter", (e) => {
      const me = e;
      showTooltip(container, ev, me.clientX, me.clientY);
    });
    el.addEventListener("mousemove", (e) => {
      const me = e;
      showTooltip(container, ev, me.clientX, me.clientY);
    });
    el.addEventListener("mouseleave", () => hideTooltip());
  }
}

/**
 * Paint each era as a low-opacity full-cross-axis rectangle clipped to the
 * viewport, plus a centered label across the band. Renders behind everything
 * else so events stay readable.
 */
function drawEras(
  svg: SVGSVGElement,
  eras: TimelineEra[],
  viewport: ViewportRange,
  isVertical: boolean,
  width: number,
  height: number,
  onOpenEra?: (id: string) => void
): void {
  const timeSize = isVertical ? height : width;
  for (const era of eras) {
    if (
      era.end &&
      era.start &&
      // overlap check
      !(era.start.year > viewport.end.year || era.end.year < viewport.start.year)
    ) {
      const a1Frac = clamp01(
        fractionalPosition(era.start, viewport.start, viewport.end)
      );
      const a2Frac = clamp01(
        fractionalPosition(era.end, viewport.start, viewport.end)
      );
      const a1 = a1Frac * timeSize;
      const a2 = a2Frac * timeSize;
      const span = Math.max(2, a2 - a1);
      const fill = eraFill(era);
      const rect = document.createElementNS(SVG_NS, "rect");
      if (isVertical) {
        rect.setAttribute("x", "0");
        rect.setAttribute("y", String(a1));
        rect.setAttribute("width", String(width));
        rect.setAttribute("height", String(span));
      } else {
        rect.setAttribute("x", String(a1));
        rect.setAttribute("y", String(AXIS_PAD - 4));
        rect.setAttribute("width", String(span));
        rect.setAttribute("height", String(height - AXIS_PAD - TAIL_PAD + 8));
      }
      rect.setAttribute("fill", fill);
      rect.setAttribute("opacity", "0.18");
      // Eras are clickable when a handler is supplied so the inspector can be
      // opened on them; otherwise the rect ignores pointer events so it
      // doesn't intercept clicks on the event bars sitting on top.
      if (onOpenEra) {
        rect.setAttribute("cursor", "pointer");
        rect.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpenEra(era.id);
        });
      } else {
        rect.setAttribute("pointer-events", "none");
      }
      svg.appendChild(rect);

      // Era name — centered inside the band at the TOP of the canvas (just
      // under the axis line) so it doesn't collide with event bars below
      // and is consistent with how Timeline Project itself paints it.
      // Color uses the era's own RGB at full saturation; the background
      // band already gives the subtle wash.
      if (era.name && span > 30) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", "0");
        label.setAttribute("y", "0");
        if (isVertical) {
          label.setAttribute("text-anchor", "start");
          label.setAttribute("dominant-baseline", "middle");
        } else {
          label.setAttribute("text-anchor", "middle");
          label.setAttribute("dominant-baseline", "hanging");
        }
        label.setAttribute("class", "txs-era-label");
        label.setAttribute("fill", saturateForLabel(era));
        label.textContent = era.name;
        if (onOpenEra) {
          label.setAttribute("cursor", "pointer");
          label.addEventListener("click", (e) => {
            e.stopPropagation();
            onOpenEra(era.id);
          });
        }
        if (isVertical) {
          anchored(svg, label, 6, (a1 + a2) / 2);
        } else {
          anchored(svg, label, (a1 + a2) / 2, AXIS_PAD + 4);
        }
      }
    }
  }
}

interface StickyLabel {
  g: SVGGElement;
  from: number;
  to: number;
  cross: number;
  width: number;
  /** Last position written, so an unchanged frame costs nothing. */
  at: number;
}

/**
 * One scroll listener drives everything that depends on what is on screen:
 * the axis marks for the visible stretch, and each label's position inside
 * its own bar (a span running off both edges would otherwise show no text at
 * all when zoomed in).
 *
 * Both are kept cheap enough for a fast flick: labels are sorted by start so
 * the visible run can be found by binary search instead of a full scan, and a
 * label whose position has not meaningfully changed is left alone.
 */
function attachViewportPainters(
  wrapper: HTMLElement,
  isVertical: boolean,
  paintAxis: (viewFrom: number, viewTo: number) => void,
  labels: StickyLabel[]
): void {
  labels.sort((a, b) => a.from - b.from);
  const ends = labels.map((l) => l.to);
  let frame: number | null = null;

  /** First label whose bar could still be on screen. */
  const firstVisible = (viewFrom: number): number => {
    let lo = 0;
    let hi = labels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] < viewFrom) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const paint = () => {
    frame = null;
    const viewFrom = isVertical ? wrapper.scrollTop : wrapper.scrollLeft;
    const size = isVertical ? wrapper.clientHeight : wrapper.clientWidth;
    const viewTo = viewFrom + size;

    paintAxis(viewFrom, viewTo);

    for (let i = firstVisible(viewFrom); i < labels.length; i++) {
      const l = labels[i];
      if (l.from > viewTo) break; // sorted: everything after is off screen too
      const latest = Math.max(l.from, l.to - l.width);
      const target = Math.min(Math.max(l.from, viewFrom + LABEL_PAD), latest);
      if (Math.abs(target - l.at) < 1) continue;
      l.at = target;
      const rotate = isVertical ? " rotate(90)" : "";
      const x = isVertical ? l.cross : target;
      const y = isVertical ? target : l.cross;
      l.g.setAttribute("transform", `translate(${x} ${y})${rotate}`);
    }
  };

  wrapper.addEventListener(
    "scroll",
    () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(paint);
    },
    { passive: true }
  );
  // First paint once the wrapper has a size.
  window.requestAnimationFrame(paint);
}

function saturateForLabel(era: TimelineEra): string {
  // Use the era's CSS color if it parses, otherwise the deterministic hash
  // color. Either way we drop opacity back to 1 so the label stands out
  // against the 0.18-opacity background band.
  const c = rgbToCss(era.color ?? "");
  return c ?? hashColor(era.name || "era");
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function eraFill(era: TimelineEra): string {
  const css = rgbToCss(era.color ?? "");
  return css ?? hashColor(era.name || "era");
}

function drawLaneStripes(
  svg: SVGSVGElement,
  laneCount: number,
  isVertical: boolean,
  width: number,
  height: number
): void {
  for (let i = 0; i < laneCount; i++) {
    if (i % 2 === 0) continue;
    const offset = AXIS_PAD + i * (LANE_THICKNESS + LANE_GAP) - LANE_GAP / 2;
    const thickness = LANE_THICKNESS + LANE_GAP;
    const rect = document.createElementNS(SVG_NS, "rect");
    if (isVertical) {
      rect.setAttribute("x", String(offset));
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(thickness));
      rect.setAttribute("height", String(height));
    } else {
      rect.setAttribute("x", "0");
      rect.setAttribute("y", String(offset));
      rect.setAttribute("width", String(width));
      rect.setAttribute("height", String(thickness));
    }
    rect.setAttribute("fill", "var(--background-modifier-hover)");
    rect.setAttribute("opacity", "0.35");
    rect.setAttribute("pointer-events", "none");
    svg.appendChild(rect);
  }
}

/**
 * Draws the axis baseline and returns a painter for its marks.
 *
 * Marks are drawn for the visible stretch only and repainted on scroll:
 * labelling a million-pixel axis up front would emit tens of thousands of
 * nodes, and capping that count silently truncates the far end of the
 * timeline — which is why months never appeared on a long span.
 */
function drawAxis(
  svg: SVGSVGElement,
  vp: ViewportRange,
  isVertical: boolean,
  width: number,
  height: number
): (viewFrom: number, viewTo: number) => void {
  const timeSize = isVertical ? height : width;

  const line = document.createElementNS(SVG_NS, "line");
  if (isVertical) {
    line.setAttribute("x1", String(AXIS_PAD - 6));
    line.setAttribute("y1", "0");
    line.setAttribute("x2", String(AXIS_PAD - 6));
    line.setAttribute("y2", String(height));
  } else {
    line.setAttribute("x1", "0");
    line.setAttribute("y1", String(AXIS_PAD - 6));
    line.setAttribute("x2", String(width));
    line.setAttribute("y2", String(AXIS_PAD - 6));
  }
  line.setAttribute("class", "txs-axis-line");
  svg.appendChild(line);

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "txs-axis-marks");
  svg.appendChild(group);

  const target = isVertical ? 80 : 120;

  return (viewFrom: number, viewTo: number) => {
    const ticks = visibleAxisTicks(
      vp.start,
      vp.end,
      timeSize,
      viewFrom,
      viewTo,
      target
    );
    group.replaceChildren();

    for (const { px: along, label } of ticks) {
      const tick = document.createElementNS(SVG_NS, "line");
      if (isVertical) {
        tick.setAttribute("x1", String(AXIS_PAD - 12));
        tick.setAttribute("y1", String(along));
        tick.setAttribute("x2", String(AXIS_PAD - 2));
        tick.setAttribute("y2", String(along));
      } else {
        tick.setAttribute("x1", String(along));
        tick.setAttribute("y1", String(AXIS_PAD - 12));
        tick.setAttribute("x2", String(along));
        tick.setAttribute("y2", String(AXIS_PAD - 2));
      }
      tick.setAttribute("class", "txs-axis-tick");
      group.appendChild(tick);

      const grid = document.createElementNS(SVG_NS, "line");
      if (isVertical) {
        grid.setAttribute("x1", String(AXIS_PAD));
        grid.setAttribute("y1", String(along));
        grid.setAttribute("x2", String(width - TAIL_PAD));
        grid.setAttribute("y2", String(along));
      } else {
        grid.setAttribute("x1", String(along));
        grid.setAttribute("y1", String(AXIS_PAD));
        grid.setAttribute("x2", String(along));
        grid.setAttribute("y2", String(height - TAIL_PAD));
      }
      grid.setAttribute("stroke", "var(--background-modifier-border)");
      grid.setAttribute("stroke-width", "1");
      grid.setAttribute("opacity", "0.4");
      group.appendChild(grid);

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("class", "txs-axis-text");
      text.setAttribute("x", "0");
      text.setAttribute("y", "0");
      if (isVertical) text.setAttribute("text-anchor", "end");
      text.textContent = label;
      if (isVertical) {
        anchored(group, text, AXIS_PAD - 16, clampLabel(along, height));
      } else {
        anchored(group, text, clampLabel(along, width), AXIS_PAD - 16);
      }
    }
  };
}

function clampLabel(coord: number, size: number): number {
  if (coord < 28) return 28;
  if (coord > size - 28) return size - 28;
  return coord;
}

function colorFor(ev: TimelineEvent, palette: Record<string, string>): string {
  if (ev.category && palette[ev.category]) return palette[ev.category];
  if (ev.category) return hashColor(ev.category);
  if (ev.defaultColor) {
    const c = rgbToCss(ev.defaultColor);
    if (c) return c;
  }
  return "var(--interactive-accent)";
}

function rgbToCss(s: string): string | null {
  const m = s.match(/^(\d+),(\d+),(\d+)$/);
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  return s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl") ? s : null;
}

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

function contrastTextColor(fill: string): string {
  const rgb = parseColorToRgb(fill);
  if (!rgb) return "#ffffff";
  const [r, g, b] = rgb.map((v) => v / 255);
  const lum =
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b);
  return lum > 0.55 ? "#1a1a1a" : "#ffffff";
}

function srgbToLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function parseColorToRgb(s: string): [number, number, number] | null {
  if (!s) return null;
  const trimmed = s.trim();
  const hex = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const v = hex[1];
    if (v.length === 3) {
      return [
        parseInt(v[0] + v[0], 16),
        parseInt(v[1] + v[1], 16),
        parseInt(v[2] + v[2], 16),
      ];
    }
    return [
      parseInt(v.slice(0, 2), 16),
      parseInt(v.slice(2, 4), 16),
      parseInt(v.slice(4, 6), 16),
    ];
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return [parseInt(rgb[1], 10), parseInt(rgb[2], 10), parseInt(rgb[3], 10)];
  }
  const hsl = trimmed.match(/^hsla?\(\s*(\d+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i);
  if (hsl) {
    return hslToRgb(parseInt(hsl[1], 10), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100);
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

function truncate(s: string, max: number): string {
  if (max < 4) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function makeGradientIdFactory(): () => string {
  let i = 0;
  const salt = Math.random().toString(36).slice(2, 8);
  return () => `txs-fuzzy-${salt}-${i++}`;
}

/**
 * Returns the current document's URL stripped of any existing fragment, so we
 * can build absolute fragment refs like `url(<page>#id)` that bypass Obsidian
 * Mobile's iOS WebView `<base href>` resolution bug. Returns "" when window /
 * location aren't available (jsdom tests fall back to the bare `#id` form,
 * which works fine there).
 */
function makeFragmentBase(): string {
  try {
    const href = typeof window !== "undefined" ? window.location?.href : "";
    if (!href) return "";
    return href.split("#")[0];
  } catch {
    return "";
  }
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 20;
  if (p < 1) return 1;
  if (p > 49) return 49;
  return p;
}

/**
 * iOS WebView (Obsidian Mobile) is stricter than desktop Chromium about
 * `stop-color` values: a `rgb(180,80,80)` with no spaces after the commas, or
 * a `var(--…)` reference inside a gradient stop, can silently fail there and
 * paint the stop as transparent. Canonicalise to `#rrggbb` whenever we can
 * parse the input; fall back to the original string only for unknown formats.
 */
function normalizeColorForStop(color: string): string {
  const rgb = parseColorToRgb(color);
  if (!rgb) return color;
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function makeLinearFuzzyGradient(
  id: string,
  color: string,
  fuzzyStart: boolean,
  fuzzyEnd: boolean,
  isVertical: boolean,
  fadePercent: number
): SVGLinearGradientElement {
  const g = document.createElementNS(SVG_NS, "linearGradient");
  g.setAttribute("id", id);
  g.setAttribute("gradientUnits", "objectBoundingBox");
  g.setAttribute("x1", "0");
  g.setAttribute("y1", "0");
  g.setAttribute("x2", isVertical ? "0" : "1");
  g.setAttribute("y2", isVertical ? "1" : "0");

  g.setAttribute("spreadMethod", "pad");

  const stopColor = normalizeColorForStop(color);
  const p = clampPercent(fadePercent);
  const stops: Array<[string, number]> = [];
  if (fuzzyStart && fuzzyEnd) {
    stops.push(["0%", 0], [`${p}%`, 1], [`${100 - p}%`, 1], ["100%", 0]);
  } else if (fuzzyStart) {
    stops.push(["0%", 0], [`${p}%`, 1], ["100%", 1]);
  } else {
    stops.push(["0%", 1], [`${100 - p}%`, 1], ["100%", 0]);
  }
  for (const [offset, op] of stops) {
    const s = document.createElementNS(SVG_NS, "stop");
    s.setAttribute("offset", offset);
    s.setAttribute("stop-color", stopColor);
    s.setAttribute("stop-opacity", String(op));
    // Belt + braces for older iOS WebKit: some versions only honour the style
    // form of these properties, not the bare attribute.
    s.setAttribute("style", `stop-color:${stopColor};stop-opacity:${op}`);
    g.appendChild(s);
  }
  return g;
}

function makeRadialFuzzyGradient(
  id: string,
  color: string,
  fadePercent: number
): SVGRadialGradientElement {
  const g = document.createElementNS(SVG_NS, "radialGradient");
  g.setAttribute("id", id);
  g.setAttribute("gradientUnits", "objectBoundingBox");
  g.setAttribute("spreadMethod", "pad");
  g.setAttribute("cx", "0.5");
  g.setAttribute("cy", "0.5");
  g.setAttribute("r", "0.5");
  // Inner solid disc grows as the fade-percent shrinks: smaller percent =
  // narrower halo = larger solid core.
  const inner = Math.max(0, Math.min(99, 100 - 2 * clampPercent(fadePercent)));
  const stopColor = normalizeColorForStop(color);
  for (const [offset, op] of [["0%", 1], [`${inner}%`, 1], ["100%", 0]] as const) {
    const s = document.createElementNS(SVG_NS, "stop");
    s.setAttribute("offset", offset);
    s.setAttribute("stop-color", stopColor);
    s.setAttribute("stop-opacity", String(op));
    s.setAttribute("style", `stop-color:${stopColor};stop-opacity:${op}`);
    g.appendChild(s);
  }
  return g;
}

