import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { assignLanes } from "../timeline/overlap";
import {
  fractionalPosition,
  toFrontmatterString,
} from "../timeline/date";
import { hideTooltip, showTooltip } from "./tooltip";

const SVG_NS = "http://www.w3.org/2000/svg";
const LANE_HEIGHT = 26;
const LANE_GAP = 6;
const TOP_PAD = 34;
const BOTTOM_PAD = 10;
const POINT_RADIUS = 6;
const LABEL_PAD = 8;
const CHAR_W = 6.5; // approx px per character at 12px UI font
const MIN_BAR_WIDTH = 4;

export interface BarRenderArgs {
  container: HTMLElement;
  events: TimelineEvent[];
  categories: TimelineCategory[];
  viewport: ViewportRange | undefined;
  categoryColors: Record<string, string>;
  onOpenEvent: (id: string) => void;
}

export function renderBar(args: BarRenderArgs): HTMLElement {
  const { container, events, viewport, categoryColors, onOpenEvent } = args;
  const wrapper = container.createDiv({ cls: "txs-timeline-bar" });
  if (!viewport || events.length === 0) {
    wrapper.createDiv({ text: "No events to display." });
    return wrapper;
  }

  const lanes = assignLanes(events);
  const laneCount = Math.max(1, ...lanes.map((l) => l + 1));
  const width = Math.max(320, container.clientWidth || 800);
  const height = TOP_PAD + laneCount * (LANE_HEIGHT + LANE_GAP) + BOTTOM_PAD;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  drawLaneStripes(svg, laneCount, width);
  drawAxis(svg, viewport, width, height);

  const isMobile = isLikelyMobile();

  events.forEach((ev, i) => {
    const lane = lanes[i];
    const y = TOP_PAD + lane * (LANE_HEIGHT + LANE_GAP);
    const color = colorFor(ev, categoryColors);
    const textColor = contrastTextColor(color);
    if (ev.isPoint) {
      const cx = fractionalPosition(ev.start, viewport.start, viewport.end) * width;
      const cy = y + LANE_HEIGHT / 2;
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
      const x1 = fractionalPosition(ev.start, viewport.start, viewport.end) * width;
      const x2 = fractionalPosition(ev.end, viewport.start, viewport.end) * width;
      const w = Math.max(MIN_BAR_WIDTH, x2 - x1);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(x1));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(LANE_HEIGHT));
      rect.setAttribute("rx", "4");
      rect.setAttribute("ry", "4");
      rect.setAttribute("fill", color);
      rect.classList.add("txs-event-bar");
      attachEvents(rect, ev, container, onOpenEvent, isMobile);
      svg.appendChild(rect);

      const maxChars = Math.floor((w - LABEL_PAD * 2) / CHAR_W);
      if (maxChars >= 4) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(x1 + LABEL_PAD));
        label.setAttribute("y", String(y + LANE_HEIGHT / 2));
        label.setAttribute("class", "txs-event-label");
        label.setAttribute("fill", textColor);
        label.textContent = truncate(ev.text, maxChars);
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
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isMobile) {
      showMobilePanel(container, ev, onOpen);
    } else {
      onOpen(ev.id);
    }
  });
  if (!isMobile) {
    el.addEventListener("mouseenter", (e) => {
      const me = e as MouseEvent;
      showTooltip(container, ev, me.offsetX, me.offsetY);
    });
    el.addEventListener("mouseleave", () => hideTooltip());
  }
}

function showMobilePanel(
  container: HTMLElement,
  ev: TimelineEvent,
  onOpen: (id: string) => void
): void {
  container.querySelectorAll(".txs-mobile-panel").forEach((p) => p.remove());
  const panel = container.createDiv({ cls: "txs-mobile-panel" });
  panel.createEl("div", { text: ev.text }).style.fontWeight = "600";
  panel.createEl("div", {
    text: ev.isPoint
      ? toFrontmatterString(ev.start)
      : `${toFrontmatterString(ev.start)} → ${toFrontmatterString(ev.end)}`,
  });
  if (ev.category) panel.createEl("div", { text: `Category: ${ev.category}` });
  if (ev.description) {
    const d = panel.createEl("div", { text: ev.description });
    d.style.marginTop = "4px";
    d.style.color = "var(--text-muted)";
  }
  const openBtn = panel.createEl("button", { text: "Open note" });
  openBtn.style.marginTop = "6px";
  openBtn.addEventListener("click", () => onOpen(ev.id));
  const closeBtn = panel.createEl("button", { text: "Close" });
  closeBtn.style.marginLeft = "6px";
  closeBtn.addEventListener("click", () => panel.remove());
}

function drawLaneStripes(svg: SVGSVGElement, laneCount: number, width: number): void {
  for (let i = 0; i < laneCount; i++) {
    if (i % 2 === 0) continue;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", "0");
    rect.setAttribute("y", String(TOP_PAD + i * (LANE_HEIGHT + LANE_GAP) - LANE_GAP / 2));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(LANE_HEIGHT + LANE_GAP));
    rect.setAttribute("fill", "var(--background-modifier-hover)");
    rect.setAttribute("opacity", "0.35");
    svg.appendChild(rect);
  }
}

function drawAxis(
  svg: SVGSVGElement,
  vp: ViewportRange,
  width: number,
  height: number
): void {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", String(TOP_PAD - 6));
  line.setAttribute("x2", String(width));
  line.setAttribute("y2", String(TOP_PAD - 6));
  line.setAttribute("class", "txs-axis-line");
  svg.appendChild(line);

  const tickCount = Math.min(8, Math.max(4, Math.floor(width / 120)));
  for (let i = 0; i <= tickCount; i++) {
    const x = (i / tickCount) * width;
    const t = document.createElementNS(SVG_NS, "line");
    t.setAttribute("x1", String(x));
    t.setAttribute("y1", String(TOP_PAD - 12));
    t.setAttribute("x2", String(x));
    t.setAttribute("y2", String(TOP_PAD - 2));
    t.setAttribute("class", "txs-axis-tick");
    svg.appendChild(t);

    const grid = document.createElementNS(SVG_NS, "line");
    grid.setAttribute("x1", String(x));
    grid.setAttribute("y1", String(TOP_PAD));
    grid.setAttribute("x2", String(x));
    grid.setAttribute("y2", String(height - BOTTOM_PAD));
    grid.setAttribute("stroke", "var(--background-modifier-border)");
    grid.setAttribute("stroke-width", "1");
    grid.setAttribute("opacity", "0.4");
    svg.appendChild(grid);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(clampLabel(x, width)));
    text.setAttribute("y", String(TOP_PAD - 16));
    text.setAttribute("class", "txs-axis-text");
    text.textContent = interpolateYearLabel(vp, i / tickCount);
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

function clampLabel(x: number, width: number): number {
  if (x < 28) return 28;
  if (x > width - 28) return width - 28;
  return x;
}

/**
 * Color resolution order: category color (settings) > category color (XML
 * mapped by hash) > event default_color > deterministic per-category hash >
 * accent fallback. Putting category first means imported palettes win over
 * Timeline 2.11's per-event default_color, which is often a generic gray.
 */
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

/** Best-effort black/white text based on perceived luminance of fill color. */
function contrastTextColor(fill: string): string {
  const rgb = parseColorToRgb(fill);
  if (!rgb) return "#ffffff";
  // Relative luminance (sRGB approximation).
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
  // #rgb / #rrggbb
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

function isLikelyMobile(): boolean {
  return (
    typeof window !== "undefined" &&
    (("ontouchstart" in window) ||
      (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1)
  );
}
