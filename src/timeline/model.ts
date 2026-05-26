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
  /** Category-level XML attributes. */
  xmlAttrs?: Record<string, string>;
  /** Unknown category child nodes serialized as preserveOrder JSON strings. */
  xmlExtraNodes?: string[];
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
  container?: string;
  description?: string;
  hyperlink?: string;
  labels?: string[];
  progress?: number;
  period?: boolean;
  showTime?: boolean;
  fuzzyStart?: boolean;
  fuzzyEnd?: boolean;
  fuzzy?: boolean;
  locked?: boolean;
  endsToday?: boolean;
  defaultColor?: Color;
  /**
   * Raw base64-encoded image payload from the Timeline XML <icon> tag.
   * Stored as the bare base64 string (no `data:` prefix). When syncing into
   * Markdown we write this byte stream to a vault attachment and replace it
   * with `iconAttachmentPath`. On the way back to XML we re-base64 the
   * attachment bytes so the picture round-trips.
   */
  icon?: string;
  /** Vault-relative path to the icon attachment (set during MD render). */
  iconAttachmentPath?: string;
  alert?: string;
  /** Event-level XML attributes (excluding id which is represented by `id`). */
  xmlAttrs?: Record<string, string>;
  /** Unknown event child nodes serialized as preserveOrder JSON strings. */
  xmlExtraNodes?: string[];
  /**
   * Preserved raw event subtree (preserveOrder structure). Used to re-emit
   * unknown child nodes/attributes when no semantic edit was made.
   * Stored as opaque — sync-engine decides whether to use it.
   */
  raw?: unknown;
}

/**
 * Timeline Project's `<era>` element — a coloured background band that spans
 * a date range and renders behind the event bars. Not the same as an event.
 */
export interface TimelineEra {
  id: string;
  name: string;
  start: TimelineDate;
  end: TimelineDate;
  color?: Color;
  /** Era-level XML attributes. */
  xmlAttrs?: Record<string, string>;
  /** Unknown era child nodes serialized as preserveOrder JSON strings. */
  xmlExtraNodes?: string[];
  /** Preserved raw `<era>` subtree for unknown sub-elements. */
  raw?: unknown;
  /**
   * Epoch-ms mtime of source XML when era MD was last written from it.
   * Used by importXml to detect locally edited era notes (file mtime > stamp)
   * and skip them. Only relevant on EventNote-equivalent of eras.
   */
  lastSyncedXmlMtime?: number;
}

export interface DisplayedPeriod {
  start: TimelineDate;
  end: TimelineDate;
}

export interface TimelineView {
  displayedPeriod?: DisplayedPeriod;
  hiddenCategories?: string[];
  /** View-level XML attributes. */
  xmlAttrs?: Record<string, string>;
  /** Unknown view child nodes serialized as preserveOrder JSON strings. */
  xmlExtraNodes?: string[];
  raw?: unknown;
}

export interface TimelineDoc {
  version?: string;
  timetype?: string;
  categories: TimelineCategory[];
  events: TimelineEvent[];
  eras?: TimelineEra[];
  view?: TimelineView;
  /** Root <timeline> XML attributes. */
  xmlAttrs?: Record<string, string>;
  /** Unknown root-level timeline child nodes serialized as preserveOrder JSON strings. */
  xmlExtraNodes?: string[];
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
  /**
   * Epoch-ms mtime of the source XML when this note was last written by the
   * plugin (read from `timeline.last_synced_xml_mtime`). Used by importXml to
   * detect locally edited notes and skip them. Undefined for legacy notes.
   */
  lastSyncedXmlMtime?: number;
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
