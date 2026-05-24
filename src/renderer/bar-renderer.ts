import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { assignLanes } from "../timeline/overlap";
import {
  fractionalPosition,
  toFrontmatterString,
} from "../timeline/date";
import { hideTooltip, showTooltip } from "./tooltip";

const SVG_NS = "http://www.w3.org/2000/svg";
const LANE_HEIGHT = 22;
const LANE_GAP = 4;
const TOP_PAD = 28; // room for axis labels
const BOTTOM_PAD = 8;
const POINT_RADIUS = 5;

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
  // Use parent width if available; fall back to 800.
  const width = Math.max(320, container.clientWidth || 800);
  const height = TOP_PAD + laneCount * (LANE_HEIGHT + LANE_GAP) + BOTTOM_PAD;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  drawAxis(svg, viewport, width);

  const isMobile = isLikelyMobile();

  events.forEach((ev, i) => {
    const lane = lanes[i];
    const y = TOP_PAD + lane * (LANE_HEIGHT + LANE_GAP);
    const color = colorFor(ev, categoryColors);
    if (ev.isPoint) {
      const cx = fractionalPosition(ev.start, viewport.start, viewport.end) * width;
      const cy = y + LANE_HEIGHT / 2;
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", String(POINT_RADIUS));
      circle.setAttribute("fill", color);
      circle.classList.add("txs-event-point");
      attachEvents(circle, ev, container, onOpenEvent, isMobile);
      svg.appendChild(circle);
    } else {
      const x1 = fractionalPosition(ev.start, viewport.start, viewport.end) * width;
      const x2 = fractionalPosition(ev.end, viewport.start, viewport.end) * width;
      const w = Math.max(2, x2 - x1);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(x1));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(w));
      rect.setAttribute("height", String(LANE_HEIGHT));
      rect.setAttribute("fill", color);
      rect.classList.add("txs-event-bar");
      attachEvents(rect, ev, container, onOpenEvent, isMobile);
      svg.appendChild(rect);

      if (w > 60) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(x1 + 6));
        label.setAttribute("y", String(y + LANE_HEIGHT / 2));
        label.setAttribute("class", "txs-event-label");
        label.textContent = truncate(ev.text, Math.floor(w / 7));
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
  // Remove any existing panel
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

function drawAxis(svg: SVGSVGElement, vp: ViewportRange, width: number): void {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "0");
  line.setAttribute("y1", String(TOP_PAD - 6));
  line.setAttribute("x2", String(width));
  line.setAttribute("y2", String(TOP_PAD - 6));
  line.setAttribute("class", "txs-axis-line");
  svg.appendChild(line);

  // 5 ticks
  for (let i = 0; i <= 5; i++) {
    const x = (i / 5) * width;
    const t = document.createElementNS(SVG_NS, "line");
    t.setAttribute("x1", String(x));
    t.setAttribute("y1", String(TOP_PAD - 10));
    t.setAttribute("x2", String(x));
    t.setAttribute("y2", String(TOP_PAD - 2));
    t.setAttribute("class", "txs-axis-tick");
    svg.appendChild(t);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(clampLabel(x, width)));
    text.setAttribute("y", String(TOP_PAD - 14));
    text.setAttribute("class", "txs-axis-text");
    text.textContent = interpolateYearLabel(vp, i / 5);
    svg.appendChild(text);
  }
}

function interpolateYearLabel(vp: ViewportRange, t: number): string {
  // Year-only label is robust across BCE/CE without invoking Date.
  const y = vp.start.year + (vp.end.year - vp.start.year) * t;
  return formatYear(Math.round(y));
}

function formatYear(y: number): string {
  return y < 0 ? `${-y} BCE` : `${y}`;
}

function clampLabel(x: number, width: number): number {
  if (x < 24) return 24;
  if (x > width - 24) return width - 24;
  return x;
}

function colorFor(ev: TimelineEvent, palette: Record<string, string>): string {
  if (ev.defaultColor) return rgbToCss(ev.defaultColor) || "var(--interactive-accent)";
  if (ev.category && palette[ev.category]) return palette[ev.category];
  if (ev.category) {
    // Stable hash-based color for unknown categories
    return hashColor(ev.category);
  }
  return "var(--interactive-accent)";
}

function rgbToCss(s: string): string | null {
  const m = s.match(/^(\d+),(\d+),(\d+)$/);
  if (!m) return s.startsWith("#") || s.startsWith("rgb") ? s : null;
  return `rgb(${m[1]},${m[2]},${m[3]})`;
}

function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 50%, 55%)`;
}

function truncate(s: string, max: number): string {
  if (max < 4) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function isLikelyMobile(): boolean {
  // Obsidian provides `Platform.isMobile` but renderer is also unit-loaded.
  // Detect via touch capability without importing Obsidian.
  return (
    typeof window !== "undefined" &&
    (("ontouchstart" in window) || (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1)
  );
}
