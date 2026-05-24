import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { renderBar } from "./bar-renderer";
import { renderList } from "./list-renderer";
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
}

export function renderTimeline(args: RenderArgs): void {
  args.container.empty();
  args.container.addClass("txs-timeline");

  const { mode } = args.options;
  if (mode === "bar" || mode === "hybrid") {
    renderBar({
      container: args.container,
      events: args.events,
      categories: args.categories,
      viewport: args.viewport,
      categoryColors: args.categoryColors,
      onOpenEvent: args.onOpenEvent,
      zoom: args.options.zoom,
      orientation: args.options.orientation,
    });
  }
  if (mode === "list" || mode === "hybrid") {
    renderList({
      container: args.container,
      events: args.events,
      options: args.options,
      onOpenEvent: args.onOpenEvent,
    });
  }
  if (args.events.length === 0) {
    args.container.createDiv({ text: "No events to display." });
  }
}
