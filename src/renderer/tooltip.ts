import type { TimelineEvent } from "../timeline/model";
import { toFrontmatterString } from "../timeline/date";

let activeTip: HTMLElement | null = null;

export function showTooltip(
  container: HTMLElement,
  ev: TimelineEvent,
  x: number,
  y: number
): void {
  hideTooltip();
  const tip = document.createElement("div");
  tip.className = "txs-tooltip";
  tip.style.left = `${x + 12}px`;
  tip.style.top = `${y + 12}px`;
  tip.innerHTML = "";
  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.textContent = ev.text;
  tip.appendChild(title);

  const dates = document.createElement("div");
  dates.style.fontFamily = "var(--font-monospace)";
  dates.style.fontSize = "0.85em";
  dates.style.color = "var(--text-muted)";
  dates.textContent = ev.isPoint
    ? toFrontmatterString(ev.start)
    : `${toFrontmatterString(ev.start)} → ${toFrontmatterString(ev.end)}`;
  tip.appendChild(dates);

  if (ev.category) {
    const cat = document.createElement("div");
    cat.style.marginTop = "2px";
    cat.textContent = `Category: ${ev.category}`;
    tip.appendChild(cat);
  }
  if (ev.description) {
    const d = document.createElement("div");
    d.style.marginTop = "4px";
    d.style.maxHeight = "120px";
    d.style.overflow = "hidden";
    d.textContent = truncate(ev.description, 240);
    tip.appendChild(d);
  }

  container.appendChild(tip);
  activeTip = tip;
}

export function hideTooltip(): void {
  if (activeTip && activeTip.parentNode) {
    activeTip.parentNode.removeChild(activeTip);
  }
  activeTip = null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
