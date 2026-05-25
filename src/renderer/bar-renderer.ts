import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { assignLanes } from "../timeline/overlap";
import {
  fractionalPosition,
  toFrontmatterString,
} from "../timeline/date";
import { hideTooltip, showTooltip } from "./tooltip";
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

  const lanes = assignLanes(events);
  const laneCount = Math.max(1, ...lanes.map((l) => l + 1));

  const containerSize = isVertical
    ? Math.max(280, container.clientWidth || 640)
    : Math.max(320, container.clientWidth || 800);
  // Time-axis size grows with zoom; cross-axis is laneCount-derived.
  const timeAxisBase = isVertical
    ? Math.max(360, container.clientHeight || 600)
    : containerSize;
  const timeAxisSize = Math.max(120, Math.round(timeAxisBase * zoom));
  const crossAxisSize =
    AXIS_PAD + laneCount * (LANE_THICKNESS + LANE_GAP) + TAIL_PAD;

  const width = isVertical ? crossAxisSize : timeAxisSize;
  const height = isVertical ? timeAxisSize : crossAxisSize;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  drawLaneStripes(svg, laneCount, isVertical, width, height);
  drawAxis(svg, viewport, isVertical, width, height);

  const isMobile = args.isMobile;

  events.forEach((ev, i) => {
    const lane = lanes[i];
    const cross = AXIS_PAD + lane * (LANE_THICKNESS + LANE_GAP);
    const color = colorFor(ev, categoryColors);
    const textColor = contrastTextColor(color);
    if (ev.isPoint) {
      const along =
        fractionalPosition(ev.start, viewport.start, viewport.end) *
        timeAxisSize;
      const cx = isVertical ? cross + LANE_THICKNESS / 2 : along;
      const cy = isVertical ? along : cross + LANE_THICKNESS / 2;
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", String(POINT_RADIUS));
      circle.setAttribute("fill", color);
      circle.setAttribute("stroke", "var(--background-primary)");
      circle.setAttribute("stroke-width", "1");
      circle.classList.add("txs-event-point");
      attachEvents(circle, ev, container, onOpenEvent, isMobile);
      svg.appendChild(circle);
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
      rect.setAttribute("fill", color);
      rect.classList.add("txs-event-bar");
      attachEvents(rect, ev, container, onOpenEvent, isMobile);
      svg.appendChild(rect);

      const maxChars = Math.floor((span - LABEL_PAD * 2) / CHAR_W);
      if (maxChars >= 4) {
        const label = document.createElementNS(SVG_NS, "text");
        const text = truncate(ev.text, maxChars);
        if (isVertical) {
          const tx = cross + LANE_THICKNESS / 2;
          const ty = a1 + LABEL_PAD;
          label.setAttribute("x", String(tx));
          label.setAttribute("y", String(ty));
          label.setAttribute(
            "transform",
            `rotate(90 ${tx} ${ty})`
          );
          label.setAttribute("text-anchor", "start");
        } else {
          label.setAttribute("x", String(a1 + LABEL_PAD));
          label.setAttribute("y", String(cross + LANE_THICKNESS / 2));
        }
        label.setAttribute("class", "txs-event-label");
        label.setAttribute("fill", textColor);
        label.textContent = text;
        svg.appendChild(label);
      }
    }
  });

  wrapper.appendChild(svg);
  return wrapper;
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
  (el as unknown as HTMLElement).style.cursor = "pointer";
  el.setAttribute("style", `${el.getAttribute("style") ?? ""} touch-action: manipulation;`);

  if (!isMobile) {
    el.addEventListener("mouseenter", (e) => {
      const me = e as MouseEvent;
      showTooltip(container, ev, me.clientX, me.clientY);
    });
    el.addEventListener("mousemove", (e) => {
      const me = e as MouseEvent;
      showTooltip(container, ev, me.clientX, me.clientY);
    });
    el.addEventListener("mouseleave", () => hideTooltip());
  }
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

function drawAxis(
  svg: SVGSVGElement,
  vp: ViewportRange,
  isVertical: boolean,
  width: number,
  height: number
): void {
  const timeSize = isVertical ? height : width;
  // Axis baseline
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

  const tickCount = Math.min(
    16,
    Math.max(4, Math.floor(timeSize / (isVertical ? 80 : 120)))
  );
  for (let i = 0; i <= tickCount; i++) {
    const t = i / tickCount;
    const along = t * timeSize;

    // tick mark
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
    svg.appendChild(tick);

    // grid line
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
    svg.appendChild(grid);

    // label
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("class", "txs-axis-text");
    if (isVertical) {
      text.setAttribute("x", String(AXIS_PAD - 16));
      text.setAttribute("y", String(clampLabel(along, height)));
      text.setAttribute("text-anchor", "end");
    } else {
      text.setAttribute("x", String(clampLabel(along, width)));
      text.setAttribute("y", String(AXIS_PAD - 16));
    }
    text.textContent = interpolateYearLabel(vp, t);
    svg.appendChild(text);
  }
}

function interpolateYearLabel(vp: ViewportRange, t: number): string {
  const y = vp.start.year + (vp.end.year - vp.start.year) * t;
  return formatYear(Math.round(y));
}

function formatYear(y: number): string {
  return y < 0 ? `${-y} BCE` : `${y}`;
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

