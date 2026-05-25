import YAML from "yaml";
import { toFrontmatterString } from "./date";
import {
  DEFAULT_MIRROR_NAMES,
  type EventNote,
  type MirrorPropertyNames,
  type TimelineEvent,
} from "./model";

export interface WriteOptions {
  sourceXmlPath: string;
  /** Logical timeline id (groups events that belong to the same XML file). */
  timelineId: string;
  mirrorNames?: MirrorPropertyNames;
  /** Pass through any extra frontmatter the user kept on the note. */
  extraFrontmatter?: Record<string, unknown>;
  /** Existing body (Markdown below frontmatter). If absent we synthesize one. */
  body?: string;
}

const SECTION_TEXT = "## Text";
const SECTION_DESC = "## Description";

/**
 * Render an EventNote (or raw TimelineEvent) to a Markdown file string.
 * The plugin always rewrites the frontmatter `timeline:` block to canonical
 * shape, but preserves unrelated user keys via `extraFrontmatter`.
 */
export function renderEventMarkdown(
  ev: TimelineEvent,
  opts: WriteOptions
): string {
  const mirrors = opts.mirrorNames ?? DEFAULT_MIRROR_NAMES;
  const front: Record<string, unknown> = { ...(opts.extraFrontmatter ?? {}) };

  // Guarantee title + tags exist (don't clobber if user provided).
  if (!("title" in front)) front.title = ev.text;
  if (!("tags" in front)) front.tags = ["Timeline"];

  front.timeline = {
    enabled: true,
    id: opts.timelineId,
    event_id: ev.id,
    role: "event",
    source_xml: opts.sourceXmlPath,
    category: ev.category ?? "Uncategorized",
    render: true,
    ends_today: ev.endsToday ?? false,
    hyperlink: ev.hyperlink ?? null,
    start: {
      year: ev.start.year,
      month: ev.start.month ?? null,
      day: ev.start.day ?? null,
      hour: ev.start.hour ?? 0,
      minute: ev.start.minute ?? 0,
      second: ev.start.second ?? 0,
    },
    end: {
      year: ev.end.year,
      month: ev.end.month ?? null,
      day: ev.end.day ?? null,
      hour: ev.end.hour ?? 0,
      minute: ev.end.minute ?? 0,
      second: ev.end.second ?? 0,
    },
    ...(ev.labels && ev.labels.length ? { labels: ev.labels } : {}),
    ...(ev.fuzzy != null ? { fuzzy: ev.fuzzy } : {}),
    ...(ev.locked != null ? { locked: ev.locked } : {}),
    ...(ev.progress != null ? { progress: ev.progress } : {}),
    ...(ev.defaultColor != null ? { default_color: ev.defaultColor } : {}),
    ...(ev.iconAttachmentPath
      ? { icon_path: ev.iconAttachmentPath }
      : ev.icon
        ? { icon: ev.icon }
        : {}),
    ...(ev.alert != null ? { alert: ev.alert } : {}),
  };

  // Top-level mirror props
  front[mirrors.start] = toFrontmatterString(ev.start);
  front[mirrors.end] = toFrontmatterString(ev.end);
  front[mirrors.category] = ev.category ?? "Uncategorized";
  front[mirrors.eventId] = ev.id;
  front[mirrors.render] = true;
  front[mirrors.role] = "event";

  const body = opts.body ?? defaultBody(ev);
  const yaml = YAML.stringify(front, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${body}`;
}

function defaultBody(ev: TimelineEvent): string {
  const lines: string[] = [`# ${ev.text}`, ""];
  if (ev.iconAttachmentPath) {
    lines.push("## Image", "", `![[${ev.iconAttachmentPath}]]`, "");
  }
  lines.push(
    SECTION_TEXT,
    "",
    ev.text,
    "",
    SECTION_DESC,
    "",
    (ev.description ?? "").trim(),
    "",
    "## Timeline",
    "",
    "```timeline",
    "mode: hybrid",
    "source: main",
    "```",
    ""
  );
  return lines.join("\n");
}

/** Re-render an EventNote, preserving its existing body and extra frontmatter. */
export function renderExistingEventNote(
  note: EventNote,
  sourceXmlPath: string,
  timelineId: string,
  mirrorNames?: MirrorPropertyNames
): string {
  return renderEventMarkdown(note.event, {
    sourceXmlPath,
    timelineId,
    mirrorNames,
    extraFrontmatter: note.extraFrontmatter,
    body: note.body,
  });
}
