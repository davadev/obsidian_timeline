import type { TimelineCategory, TimelineEra, TimelineEvent } from "../timeline/model";
import type { ViewportRange } from "../timeline/overlap";
import { renderBar } from "./bar-renderer";
import { renderList } from "./list-renderer";
import {
  applyRichFilter,
  distinctCategories,
  renderRichFilterBar,
  type RichFilterState,
} from "./filter-bar";
import type { RenderOptions } from "./render-options";
import {
  autoViewportFromEvents,
  filterErasToViewport,
} from "../timeline/era-utils";

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
  /** Percent of bar length the fuzzy-edge gradient fades over. */
  fuzzyGradientPercent?: number;
  /** Override CSS color for event labels. Empty = auto-contrast. */
  eventLabelColor?: string;
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

  const drawEvents = (
    events: typeof args.events,
    state: RichFilterState | null,
    zoomOverride?: number | null
  ) => {
    body.empty();
    const { mode } = args.options;
    const effectiveZoom = zoomOverride != null ? zoomOverride : args.options.zoom;

    // Derive the viewport from the current filter state so the time axis,
    // event bars, and era bands all share the same range. Precedence:
    //   1. explicit filter date range (user typed a from/to in the panel)
    //   2. caller-supplied args.viewport — represents caller intent:
    //      - viewport: true blocks → host note's frontmatter timeline range
    //        (post-padded by the postprocessor's expandDegenerateViewport)
    //      - global Timeline view → autoViewport of the currently-filtered
    //        events (the view re-invokes renderTimeline per filter change)
    //   3. fall back to deriving from the events we actually have, when no
    //      caller viewport was supplied (rare — happens when the post-
    //      processor's resolveViewport returns null and events are empty)
    //
    // Important: do NOT derive from `events` before falling back to
    // args.viewport. For viewport: true blocks the postprocessor already
    // narrowed `events` to the host event's neighbourhood — if we then
    // autoViewport(events) we'd collapse to a much narrower viewport (or
    // zero-width for a single-event note), wiping out the padding and
    // breaking era visibility.
    const filterRange: ViewportRange | undefined =
      state?.start && state?.end
        ? { start: state.start, end: state.end }
        : undefined;
    const effViewport: ViewportRange | undefined =
      filterRange ?? args.viewport ?? autoViewportFromEvents(events);
    // Eras are background bands — only show the ones overlapping the visible
    // viewport so a narrow viewer doesn't get scaled to span the entire Iron
    // Age. Eras themselves have no category/label metadata so range overlap
    // is the only applicable filter.
    const effEras = filterErasToViewport(args.eras, effViewport);

    if (mode === "bar" || mode === "hybrid") {
      renderBar({
        container: body,
        events,
        categories: args.categories,
        viewport: effViewport,
        categoryColors: args.categoryColors,
        onOpenEvent: args.onOpenEvent,
        zoom: effectiveZoom,
        orientation: args.options.orientation,
        isMobile: args.isMobile,
        eras: effEras,
        onOpenEra: args.onOpenEra,
        fuzzyGradientPercent: args.fuzzyGradientPercent,
        eventLabelColor: args.eventLabelColor,
        stickyLabels: args.options.stickyLabels,
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
        eras: effEras,
        onOpenEra: args.onOpenEra,
      });
    }
    if (events.length === 0) {
      const msg = body.createDiv({ text: "No events to display." });
      // Distinguish "renderer received an empty event set from the caller"
      // (rare — usually a config/setup issue) from "events were filtered
      // out by the inline filter panel" (most common — and recoverable by
      // the user via the Clear filters button up top).
      if (args.events.length > 0) {
        msg.createDiv({
          text: "Filters are hiding all events. Expand the Filters panel above and click \"Clear filters\" to see them.",
          cls: "txs-filter-empty-hint",
        });
      }
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
        drawEvents(applyRichFilter(args.events, state), state, state.zoom);
        args.onFilterChange?.(state);
      },
    });
    drawEvents(
      applyRichFilter(args.events, handle.state),
      handle.state,
      handle.state.zoom
    );
  } else {
    drawEvents(args.events, null);
  }

  // Place body after the filter panel (createDiv appended it before).
  args.container.appendChild(body);
}
