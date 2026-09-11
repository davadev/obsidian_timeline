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
  // Hidden while it is measured; `.is-measuring` is dropped once the final
  // placement is known, so there is no flash at the pre-measure position.
  const tip = createDiv({ cls: "txs-tooltip is-measuring" });
  tip.style.left = `${clientX + 12}px`;
  tip.style.top = `${clientY + 12}px`;
  const title = createDiv({ cls: "txs-tooltip-title" });
  title.textContent = ev.text;
  tip.appendChild(title);

  const dates = createDiv({ cls: "txs-tooltip-dates" });
  dates.textContent = ev.isPoint
    ? toFrontmatterString(ev.start)
    : `${toFrontmatterString(ev.start)} → ${toFrontmatterString(ev.end)}`;
  tip.appendChild(dates);

  if (ev.category) {
    const cat = createDiv({ cls: "txs-tooltip-category" });
    cat.textContent = `Category: ${ev.category}`;
    tip.appendChild(cat);
  }
  if (ev.description) {
    const d = createDiv({ cls: "txs-tooltip-desc" });
    d.textContent = truncate(ev.description, 240);
    tip.appendChild(d);
  }

  // Measure once, then reposition + reveal.
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
  tip.removeClass("is-measuring");
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
