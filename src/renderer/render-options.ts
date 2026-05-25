export type RenderMode = "bar" | "list" | "hybrid";
export type DetailsStyle = "list" | "compact" | "table" | "cards";
export type SortOrder = "chronological" | "reverse-chronological" | "category";
export type Orientation = "horizontal" | "vertical";

export type ShowField =
  | "title"
  | "date"
  | "category"
  | "description"
  | "tags"
  | "links"
  | "source";

export interface RenderOptions {
  mode: RenderMode;
  source: string; // logical timeline id (matches timeline.id in frontmatter)
  sourceXmlOverride?: string; // direct XML path override
  details: DetailsStyle;
  sort: SortOrder;
  show: ShowField[];
  categoryInclude?: string[];
  categoryExclude?: string[];
  /** Time-axis scale multiplier — 1 = container width, 4 = 4× wider with horizontal scroll. */
  zoom: number;
  /** Axis orientation. Vertical reads top→bottom, lanes are columns. */
  orientation: Orientation;
  /** Years to pad on each side of a zero-span viewport (single-point event note). */
  pointPaddingYears?: number;
  /** Show the in-rendered filter chip bar above the timeline. */
  showFilterUI: boolean;
  /**
   * Render only the events whose text matches one of these strings (case-insensitive
   * substring). Useful when embedding a timeline in a note that isn't itself an
   * event — e.g. a topic note that should display a curated subset.
   */
  eventNames?: string[];
  /** Render only events that overlap [rangeYears[0], rangeYears[1]] (inclusive). */
  rangeYears?: [number, number];
  /** Render only events that carry one of these labels. */
  labelsInclude?: string[];
  /** Hide events that carry any of these labels. */
  labelsExclude?: string[];
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  mode: "hybrid",
  source: "main",
  details: "list",
  sort: "chronological",
  show: ["title", "date", "category", "description"],
  zoom: 1,
  orientation: "horizontal",
  showFilterUI: true,
};
