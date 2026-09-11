import type { TimelineEra, TimelineEvent } from "../timeline/model";
import { compare, toFrontmatterString } from "../timeline/date";
import type { RenderOptions } from "./render-options";

export interface ListRenderArgs {
  container: HTMLElement;
  events: TimelineEvent[];
  options: RenderOptions;
  onOpenEvent: (id: string) => void;
  /** When true, list-item titles are not auto-navigable — user must tap the
   * explicit "Open note" affordance. Avoids accidental navigation on mobile. */
  isMobile?: boolean;
  /** Category palette so the inline category badge can use the real color. */
  categoryColors?: Record<string, string>;
  eras?: TimelineEra[];
  onOpenEra?: (eraId: string) => void;
}

export function renderList(args: ListRenderArgs): HTMLElement {
  const { container, events, options, onOpenEvent, isMobile, eras, onOpenEra } = args;

  // Eras section — separate list above the events. Each entry shows the
  // era name, date range, color swatch and an explicit "Open era" link.
  if (eras && eras.length) {
    container.createEl("h4", { cls: "txs-era-list-heading", text: "Eras" });
    const eraUl = container.createEl("ul", { cls: "txs-era-list" });
    const sortedEras = eras
      .slice()
      .sort((a, b) =>
        a.start.year !== b.start.year
          ? a.start.year - b.start.year
          : (a.start.month ?? 1) - (b.start.month ?? 1)
      );
    for (const era of sortedEras) {
      const li = eraUl.createEl("li", { cls: "txs-era-list-item" });
      const sw = createSpan();
      sw.className = "txs-era-chip-sw";
      sw.style.background = eraSwatchColor(era.color);
      li.appendChild(sw);
      const range = li.createSpan({ cls: "txs-date" });
      range.textContent = `${toFrontmatterString(era.start)} → ${toFrontmatterString(era.end)}`;
      const titleEl = li.createSpan({ cls: "txs-title", text: ` ${era.name}` });
      titleEl.addClass("txs-list-era-title");
      if (onOpenEra) {
        const openLink = li.createEl("a", {
          cls: "txs-open-note",
          text: " Open era →",
          href: "#",
        });
        openLink.addEventListener("click", (e) => {
          e.preventDefault();
          onOpenEra(era.id);
        });
      }
    }
  }

  const sorted = sortEvents(events, options.sort);
  const ul = container.createEl("ul", { cls: "txs-timeline-list" });
  for (const ev of sorted) {
    const li = ul.createEl("li");

    let titleEl: HTMLElement;
    if (isMobile) {
      // Plain text — no auto-navigation. User must tap the explicit Open note.
      titleEl = li.createSpan({ cls: "txs-title", text: ev.text });
    } else {
      const link = li.createEl("a", { cls: "txs-title", text: ev.text, href: "#" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        onOpenEvent(ev.id);
      });
      titleEl = link;
    }

    if (showField(options, "date")) {
      const d = li.createSpan({ cls: "txs-date" });
      d.textContent = ev.isPoint
        ? toFrontmatterString(ev.start)
        : `${toFrontmatterString(ev.start)} → ${toFrontmatterString(ev.end)}`;
      li.insertBefore(d, titleEl);
    }
    if (showField(options, "category") && ev.category) {
      const cat = li.createSpan({ cls: "txs-category", text: ev.category });
      const color = args.categoryColors?.[ev.category];
      if (color) {
        cat.style.background = color;
        cat.style.color = contrastTextColor(color);
      }
    }
    if (showField(options, "description") && ev.description) {
      const d = li.createSpan({ cls: "txs-desc" });
      d.textContent =
        options.details === "compact"
          ? truncate(ev.description, 160)
          : ev.description;
    }
    if (showField(options, "tags") && ev.labels && ev.labels.length) {
      const t = li.createSpan({ cls: "txs-desc" });
      t.textContent = `tags: ${ev.labels.join(", ")}`;
    }
    if (showField(options, "links") && ev.hyperlink) {
      const link2 = li.createEl("a", { href: ev.hyperlink, text: ev.hyperlink });
      link2.setAttr("target", "_blank");
      link2.setAttr("rel", "noopener");
      link2.addClass("txs-list-link");
    }

    // Explicit Open-note affordance — always shown, primary action on mobile.
    const actions = li.createDiv({ cls: "txs-list-actions" });
    const openLink = actions.createEl("a", {
      cls: "txs-open-note",
      text: "Open note →",
      href: "#",
    });
    openLink.addEventListener("click", (e) => {
      e.preventDefault();
      onOpenEvent(ev.id);
    });
  }
  return ul;
}

function showField(opt: RenderOptions, field: string): boolean {
  return opt.show.includes(field as RenderOptions["show"][number]);
}

function sortEvents(
  events: TimelineEvent[],
  order: RenderOptions["sort"]
): TimelineEvent[] {
  const copy = events.slice();
  if (order === "reverse-chronological") {
    copy.sort((a, b) => compare(b.start, a.start));
  } else if (order === "category") {
    copy.sort((a, b) => {
      const c = (a.category ?? "").localeCompare(b.category ?? "");
      return c !== 0 ? c : compare(a.start, b.start);
    });
  } else {
    copy.sort((a, b) => compare(a.start, b.start));
  }
  return copy;
}

function eraSwatchColor(c?: string): string {
  if (!c) return "var(--text-muted)";
  const m = c.match(/^(\d+),(\d+),(\d+)$/);
  return m ? `rgb(${m[1]},${m[2]},${m[3]})` : c;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Black or white based on color luminance — mirrors bar-renderer logic. */
function contrastTextColor(fill: string): string {
  const m = fill.match(/^#([0-9a-f]{6})$/i);
  let r = 200, g = 200, b = 200;
  if (m) {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
  } else {
    const rgb = fill.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
      r = parseInt(rgb[1], 10);
      g = parseInt(rgb[2], 10);
      b = parseInt(rgb[3], 10);
    }
  }
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}
