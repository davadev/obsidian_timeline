import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { renderBar } from "./bar-renderer";
import { renderList } from "./list-renderer";
import { distinctCategories, loadHidden, renderFilterBar } from "./filter-bar";
import type { RenderOptions } from "./render-options";

export { DEFAULT_RENDER_OPTIONS, type RenderOptions } from "./render-options";

export interface RenderArgs {
  container: HTMLElement;
  events: TimelineEvent[];
  categories: TimelineCategory[];
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
}

export function renderTimeline(args: RenderArgs): void {
  args.container.empty();
  args.container.addClass("txs-timeline");

  // Mount-point for the bar+list combo (so filter chips re-render only the body).
  const body = args.container.createDiv({ cls: "txs-timeline-body" });

  const draw = (hidden: Set<string>) => {
    body.empty();
    const visibleEvents = args.events.filter(
      (e) => !e.category || !hidden.has(e.category)
    );
    const { mode } = args.options;
    if (mode === "bar" || mode === "hybrid") {
      renderBar({
        container: body,
        events: visibleEvents,
        categories: args.categories,
        viewport: args.viewport,
        categoryColors: args.categoryColors,
        onOpenEvent: args.onOpenEvent,
        zoom: args.options.zoom,
        orientation: args.options.orientation,
        isMobile: args.isMobile,
      });
    }
    if (mode === "list" || mode === "hybrid") {
      renderList({
        container: body,
        events: visibleEvents,
        options: args.options,
        onOpenEvent: args.onOpenEvent,
        isMobile: args.isMobile,
      });
    }
    if (visibleEvents.length === 0) {
      body.createDiv({ text: "No events to display." });
    }
  };

  const cats = distinctCategories(args.events, args.categories);
  if (args.options.showFilterUI && cats.length > 0) {
    renderFilterBar({
      parent: args.container,
      sourceKey: args.filterKey,
      allCategories: cats,
      initialHidden: args.initialHidden,
      categoryColors: args.categoryColors,
      onChange: (hidden) => draw(hidden),
    });
    // First paint uses persisted state (filter-bar already merged it).
    const persisted = loadHidden(args.filterKey);
    const initial = new Set<string>([...args.initialHidden, ...persisted]);
    draw(initial);
  } else {
    draw(new Set(args.initialHidden));
  }

  // Place body after the filter bar (createDiv appended it before).
  args.container.appendChild(body);
}
