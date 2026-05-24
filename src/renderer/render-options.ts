export type RenderMode = "bar" | "list" | "hybrid";
export type DetailsStyle = "list" | "compact" | "table" | "cards";
export type SortOrder = "chronological" | "reverse-chronological" | "category";

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
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  mode: "hybrid",
  source: "main",
  details: "list",
  sort: "chronological",
  show: ["title", "date", "category", "description"],
};
