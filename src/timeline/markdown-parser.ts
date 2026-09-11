import YAML from "yaml";
import { parseFrontmatterDate, type TimelineDate } from "./date";
import {
  DEFAULT_MIRROR_NAMES,
  type EventNote,
  type MirrorPropertyNames,
  type TimelineEvent,
} from "./model";
import { slugify } from "./id-utils";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ParseResult {
  note?: EventNote;
  errors: string[];
}

export interface ParseOptions {
  path: string;
  mirrorNames?: MirrorPropertyNames;
}

/**
 * Parse a Markdown event note into the canonical model.
 * - Top-level mirror fields are read for compatibility but the nested
 *   `timeline:` object is the source of truth.
 * - Notes without `timeline.enabled: true` are returned as non-events
 *   (note is undefined, errors empty).
 */
export function parseEventNote(raw: string, opts: ParseOptions): ParseResult {
  const errors: string[] = [];
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) {
    return { errors: ["No YAML frontmatter found"] };
  }

  let front: Record<string, unknown>;
  try {
    const parsed: unknown = YAML.parse(fmMatch[1]);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { errors: ["Frontmatter is not a YAML mapping"] };
    }
    front = parsed as Record<string, unknown>;
  } catch (e) {
    return { errors: [`Invalid YAML frontmatter: ${(e as Error).message}`] };
  }

  const tl = front.timeline;
  if (!tl || typeof tl !== "object" || Array.isArray(tl)) {
    // Not a timeline event — silently ignore.
    return { errors: [] };
  }
  const timeline = tl as Record<string, unknown>;
  if (timeline.enabled !== true) return { errors: [] };
  if (timeline.role && timeline.role !== "event") {
    return { errors: [] }; // viewports etc. are not events to sync
  }

  const mirrors = opts.mirrorNames ?? DEFAULT_MIRROR_NAMES;
  const body = raw.slice(fmMatch[0].length);

  const text =
    typeof front.title === "string" && front.title.trim()
      ? front.title.trim()
      : extractH1(body) ?? "Untitled";

  const start = readDate(timeline.start, "timeline.start", errors);
  const end = readDate(timeline.end, "timeline.end", errors);
  if (!start || !end) {
    return { errors };
  }

  const idRaw = timeline.event_id;
  const id =
    typeof idRaw === "string" && idRaw.trim() ? idRaw.trim() : slugify(text);

  const ev: TimelineEvent = {
    id,
    text,
    start,
    end,
    isPoint: sameInstant(start, end),
    category:
      strOrUndef(timeline.category) ?? strOrUndef(front[mirrors.category]),
    container: strOrUndef(timeline.container),
    description: extractSection(body, "Description") || undefined,
    hyperlink: strOrUndef(timeline.hyperlink),
    hyperlinks: arrayOfStrings(timeline.hyperlinks),
    labels: arrayOfStrings(timeline.labels),
    progress: numOrUndef(timeline.progress),
    period: boolOrUndef(timeline.period),
    showTime: boolOrUndef(timeline.show_time),
    fuzzyStart: boolOrUndef(timeline.fuzzy_start),
    fuzzyEnd: boolOrUndef(timeline.fuzzy_end),
    fuzzy: boolOrUndef(timeline.fuzzy),
    locked: boolOrUndef(timeline.locked),
    endsToday: boolOrUndef(timeline.ends_today),
    defaultColor: strOrUndef(timeline.default_color),
    icon: strOrUndef(timeline.icon),
    iconAttachmentPath: strOrUndef(timeline.icon_path),
    alert: strOrUndef(timeline.alert),
    timelineEnabled: boolOrUndef(timeline.enabled),
    timelineId: strOrUndef(timeline.id),
    role: strOrUndef(timeline.role),
    sourceXml: strOrUndef(timeline.source_xml),
    render: boolOrUndef(timeline.render),
    xmlAttrs: mapOfStrings(timeline.xml_attrs),
    xmlExtraNodes: arrayOfStrings(timeline.xml_extra_nodes),
    lastSyncedXmlMtime: numOrUndef(timeline.last_synced_xml_mtime),
  };
  if (!ev.hyperlinks?.length && ev.hyperlink) ev.hyperlinks = [ev.hyperlink];
  if (!ev.hyperlink && ev.hyperlinks?.length) ev.hyperlink = ev.hyperlinks[0];
  // Split extra frontmatter (everything that isn't ours)
  const extraFrontmatter: Record<string, unknown> = {};
  const reservedTop = new Set<string>([
    "timeline",
    "title",
    "tags",
    mirrors.start,
    mirrors.end,
    mirrors.category,
    mirrors.eventId,
    mirrors.render,
    mirrors.role,
  ]);
  for (const [k, v] of Object.entries(front)) {
    if (!reservedTop.has(k)) extraFrontmatter[k] = v;
  }
  // Preserve title/tags as extra so writer doesn't drop them
  if ("title" in front) extraFrontmatter.title = front.title;
  if ("tags" in front) extraFrontmatter.tags = front.tags;

  const mirrorsSeen: Record<string, unknown> = {};
  for (const key of Object.values(mirrors) as string[]) {
    if (key in front) mirrorsSeen[key] = front[key];
  }

  const lastSyncedXmlMtime = ev.lastSyncedXmlMtime;

  return {
    note: {
      event: ev,
      location: { path: opts.path },
      extraFrontmatter,
      body,
      mirrors: mirrorsSeen,
      lastSyncedXmlMtime,
    },
    errors,
  };
}

function readDate(
  raw: unknown,
  field: string,
  errors: string[]
): TimelineDate | undefined {
  if (raw == null) {
    errors.push(`Missing required field: ${field}`);
    return undefined;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.year !== "number" || !Number.isInteger(o.year)) {
      errors.push(`${field}.year must be an integer`);
      return undefined;
    }
    return {
      year: o.year,
      month: intOrUndef(o.month),
      day: intOrUndef(o.day),
      hour: intOrUndef(o.hour),
      minute: intOrUndef(o.minute),
      second: intOrUndef(o.second),
    };
  }
  const parsed = parseFrontmatterDate(raw);
  if (!parsed) {
    errors.push(`${field} is not a valid date`);
    return undefined;
  }
  return parsed;
}

function intOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

function strOrUndef(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function boolOrUndef(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function arrayOfStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length ? arr : undefined;
}

function mapOfStrings(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function sameInstant(a: TimelineDate, b: TimelineDate): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

function extractH1(body: string): string | undefined {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1] : undefined;
}

/**
 * Read the contents of a `## <name>` heading (until the next heading or EOF).
 *
 * Line-based scan instead of a regex with a lookahead — the previous regex
 * used a literal `\Z` (invalid in JS, becomes the letter Z) combined with the
 * `i` flag, so any z/Z character in the body silently truncated the capture.
 * Symptom: descriptions for events whose text contained "Hezekiah" / "Nazareth"
 * etc. imported as just the prefix before the first z.
 */
export function extractSection(body: string, name: string): string {
  const headingRe = new RegExp(`^##\\s+${escapeRe(name)}(?:\\s+#+)?\\s*$`, "i");
  const stopRe = /^#{1,6}\s+/;
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  let end = lines.length;
  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i].trimStart();
    if (ln.startsWith("```") || ln.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && stopRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  let raw = lines.slice(start, end).join("\n");
  if (raw.startsWith("\n")) raw = raw.slice(1);
  // Drop exactly one separator newline that belongs to the next heading gap,
  // not to the section payload itself.
  if (end < lines.length && raw.endsWith("\n")) raw = raw.slice(0, -1);
  return raw;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
