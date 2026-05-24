import type { TimelineDate } from "./date";

/**
 * Canonical in-memory model of a Timeline Project document.
 * `raw` preserves the original parsed XML tree (preserveOrder shape from
 * fast-xml-parser) so unknown nodes/attributes survive round-trips.
 */

export type Color = string; // canonical "r,g,b" or named

export interface TimelineCategory {
  name: string;
  color?: Color;
  progressColor?: Color;
  doneColor?: Color;
  fontColor?: Color;
  parent?: string;
  /** Original child nodes preserved verbatim for unknown fields. */
  raw?: unknown;
}

export interface TimelineEvent {
  /** Stable ID — synthesized from text if XML lacks one. Drives MD filename and event_id. */
  id: string;
  text: string;
  start: TimelineDate;
  end: TimelineDate;
  /** True when start === end (point/marker event). */
  isPoint: boolean;
  category?: string;
  description?: string;
  hyperlink?: string;
  labels?: string[];
  progress?: number;
  fuzzy?: boolean;
  locked?: boolean;
  endsToday?: boolean;
  defaultColor?: Color;
  icon?: string;
  alert?: string;
  /**
   * Preserved raw event subtree (preserveOrder structure). Used to re-emit
   * unknown child nodes/attributes when no semantic edit was made.
   * Stored as opaque — sync-engine decides whether to use it.
   */
  raw?: unknown;
}

export interface DisplayedPeriod {
  start: TimelineDate;
  end: TimelineDate;
}

export interface TimelineView {
  displayedPeriod?: DisplayedPeriod;
  hiddenCategories?: string[];
  raw?: unknown;
}

export interface TimelineDoc {
  version?: string;
  timetype?: string;
  categories: TimelineCategory[];
  events: TimelineEvent[];
  view?: TimelineView;
  /** Full original parsed tree (preserveOrder=true). Used as canonical skeleton. */
  raw?: unknown;
  /** Original XML declaration/processing instructions, preserved as-is. */
  xmlDecl?: string;
}

export interface SourceLocation {
  /** Relative vault path. */
  path: string;
}

export interface EventNote {
  event: TimelineEvent;
  location: SourceLocation;
  /** Top-level (non-timeline.*) frontmatter preserved verbatim. */
  extraFrontmatter: Record<string, unknown>;
  /** Markdown body below the frontmatter. */
  body: string;
  /** Mirror property values that were present on disk (for diffing). */
  mirrors: Record<string, unknown>;
}

/** Settings-mapped mirror property names (top-level frontmatter keys). */
export interface MirrorPropertyNames {
  start: string;
  end: string;
  category: string;
  eventId: string;
  render: string;
  role: string;
}

export const DEFAULT_MIRROR_NAMES: MirrorPropertyNames = {
  start: "timeline_start",
  end: "timeline_end",
  category: "timeline_category",
  eventId: "timeline_event_id",
  render: "timeline_render",
  role: "timeline_role",
};
