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
  /**
   * Called whenever the rich filter state changes so the caller (post-
   * processor) can serialise it back into the block's YAML and write it
   * to the source file — making filter state persistent across reloads.
   */
  onFilterChange?: (state: import("./filter-bar").RichFilterState) => void;
}

export function renderTimeline(args: RenderArgs): void {
  args.container.empty();
  args.container.addClass("txs-timeline");

  // Mount-point for the bar+list combo (so filter chips re-render only the body).
  const body = args.container.createDiv({ cls: "txs-timeline-body" });

  const drawEvents = (events: typeof args.events, zoomOverride?: number | null) => {
    body.empty();
    const { mode } = args.options;
    const effectiveZoom = zoomOverride != null ? zoomOverride : args.options.zoom;
    if (mode === "bar" || mode === "hybrid") {
      renderBar({
        container: body,
        events,
        categories: args.categories,
        viewport: args.viewport,
        categoryColors: args.categoryColors,
        onOpenEvent: args.onOpenEvent,
        zoom: effectiveZoom,
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
      onChange: (state) => {
        drawEvents(applyRichFilter(args.events, state), state.zoom);
        args.onFilterChange?.(state);
      },
    });
    drawEvents(applyRichFilter(args.events, handle.state), handle.state.zoom);
  } else {
    drawEvents(args.events);
  }

  // Place body after the filter panel (createDiv appended it before).
  args.container.appendChild(body);
}
