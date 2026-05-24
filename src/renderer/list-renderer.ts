import type { TimelineEvent } from "../timeline/model";
import { compare, toFrontmatterString } from "../timeline/date";
import type { RenderOptions } from "./render-options";

export interface ListRenderArgs {
  container: HTMLElement;
  events: TimelineEvent[];
  options: RenderOptions;
  onOpenEvent: (id: string) => void;
}

export function renderList(args: ListRenderArgs): HTMLElement {
  const { container, events, options, onOpenEvent } = args;
  const sorted = sortEvents(events, options.sort);
  const ul = container.createEl("ul", { cls: "txs-timeline-list" });
  for (const ev of sorted) {
    const li = ul.createEl("li");
    const link = li.createEl("a", { cls: "txs-title", text: ev.text, href: "#" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      onOpenEvent(ev.id);
    });
    if (showField(options, "date")) {
      const d = li.createSpan({ cls: "txs-date" });
      d.textContent = ev.isPoint
        ? toFrontmatterString(ev.start)
        : `${toFrontmatterString(ev.start)} → ${toFrontmatterString(ev.end)}`;
      li.insertBefore(d, link);
    }
    if (showField(options, "category") && ev.category) {
      const c = li.createSpan({ cls: "txs-category", text: ev.category });
      li.appendChild(c);
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
      link2.style.marginLeft = "6px";
    }
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
