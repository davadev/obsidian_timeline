import type { TimelineCategory, TimelineEra, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { renderBar } from "./bar-renderer";
import { renderList } from "./list-renderer";
import {
  applyRichFilter,
  distinctCategories,
  renderRichFilterBar,
} from "./filter-bar";
import type { RenderOptions } from "./render-options";

export { DEFAULT_RENDER_OPTIONS, type RenderOptions } from "./render-options";

export interface RenderArgs {
  container: HTMLElement;
  events: TimelineEvent[];
  categories: TimelineCategory[];
  eras?: TimelineEra[];
  viewport: ViewportRange | undefined;
  options: RenderOptions;
  onOpenEvent: (id: string) => void;
  categoryColors: Record<string, string>;
  /** Categories hidden by block options + global settings before user toggles. */
  initialHidden: string[];
  /** Stable filter-state key (usually opts.source). */
  filterKey: string;
  /** Caller-supplied mobile flag (use Obsidian's Platform.isMobile). */
  isMobile: boolean;
  /** Date filter granularity inside the inline rich filter panel. */
  filterPrecision?: "year" | "day" | "time";
  /** Optional click router for era bands / chips / list entries. */
  onOpenEra?: (eraId: string) => void;
}

export function renderTimeline(args: RenderArgs): void {
  args.container.empty();
  args.container.addClass("txs-timeline");

  // Mount-point for the bar+list combo (so filter chips re-render only the body).
  const body = args.container.createDiv({ cls: "txs-timeline-body" });

  const drawEvents = (events: typeof args.events) => {
    body.empty();
    // Era chip strip — clickable shortcuts above the bar / list, mirroring
    // the colored bands so the user can edit an era without having to find
    // its band on the canvas.
    if (args.eras && args.eras.length && args.onOpenEra) {
      const strip = body.createDiv({ cls: "txs-era-strip" });
      strip.createEl("span", { cls: "txs-era-strip-label", text: "Eras:" });
      for (const era of args.eras) {
        const chip = strip.createEl("a", {
          cls: "txs-era-chip",
          text: era.name,
          href: "#",
        });
        const sw = document.createElement("span");
        sw.className = "txs-era-chip-sw";
        sw.style.background = eraChipColor(era.color);
        chip.prepend(sw);
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          args.onOpenEra!(era.id);
        });
      }
    }
    const { mode } = args.options;
    if (mode === "bar" || mode === "hybrid") {
      renderBar({
        container: body,
        events,
        categories: args.categories,
        viewport: args.viewport,
        categoryColors: args.categoryColors,
        onOpenEvent: args.onOpenEvent,
        zoom: args.options.zoom,
        orientation: args.options.orientation,
        isMobile: args.isMobile,
        eras: args.eras,
        onOpenEra: args.onOpenEra,
      });
    }
    if (mode === "list" || mode === "hybrid") {
      renderList({
        container: body,
        events,
        options: args.options,
        onOpenEvent: args.onOpenEvent,
        isMobile: args.isMobile,
        categoryColors: args.categoryColors,
        eras: args.eras,
        onOpenEra: args.onOpenEra,
      });
    }
    if (events.length === 0) {
      body.createDiv({ text: "No events to display." });
    }
  };

  function eraChipColor(c?: string): string {
    if (!c) return "var(--text-muted)";
    const m = c.match(/^(\d+),(\d+),(\d+)$/);
    return m ? `rgb(${m[1]},${m[2]},${m[3]})` : c;
  }

  const cats = distinctCategories(args.events, args.categories);
  if (args.options.showFilterUI) {
    const handle = renderRichFilterBar({
      parent: args.container,
      sourceKey: args.filterKey,
      allCategories: cats,
      initialHidden: args.initialHidden,
      categoryColors: args.categoryColors,
      precision: args.filterPrecision ?? "year",
      defaultOpen: false, // inline blocks always collapsed by default
      onChange: (state) => drawEvents(applyRichFilter(args.events, state)),
    });
    // First paint uses persisted-or-seeded state from the panel.
    drawEvents(applyRichFilter(args.events, handle.state));
  } else {
    drawEvents(args.events);
  }

  // Place body after the filter panel (createDiv appended it before).
  args.container.appendChild(body);
}
