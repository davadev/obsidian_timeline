import type { TimelineEvent } from "../timeline/model";
import { toFrontmatterString } from "../timeline/date";

let activeTip: HTMLElement | null = null;

/**
 * Show a tooltip near the given page coordinates. Attaches to document.body
 * with `position: fixed` so it floats above any scroll container — earlier
 * versions attached it to the bar wrapper and the tooltip ended up clipped
 * or mis-positioned when the global Timeline view's scrollable body shifted.
 */
export function showTooltip(
  _container: HTMLElement,
  ev: TimelineEvent,
  clientX: number,
  clientY: number
): void {
  hideTooltip();
  const tip = document.createElement("div");
  tip.className = "txs-tooltip";
  tip.style.position = "fixed";
  tip.style.left = `${clientX + 12}px`;
  tip.style.top = `${clientY + 12}px`;
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

  // Hide first to avoid a visible flash when the initial placement is
  // outside the viewport — measure once, then reposition + show.
  tip.style.visibility = "hidden";
  document.body.appendChild(tip);
  const r = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX + 12;
  let top = clientY + 12;
  if (left + r.width > vw - 8) left = Math.max(8, clientX - r.width - 12);
  if (top + r.height > vh - 8) top = Math.max(8, clientY - r.height - 12);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.visibility = "visible";
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
