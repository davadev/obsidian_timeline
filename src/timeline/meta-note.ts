import YAML from "yaml";
import { parseFrontmatterDate, toFrontmatterString } from "./date";
import type { TimelineCategory, TimelineDoc, TimelineEra, TimelineView } from "./model";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface TimelineMetaNote {
  docPatch: Partial<TimelineDoc>;
  /** XML mtime when the meta-note was last written by importXml. */
  lastSyncedXmlMtime?: number;
}

export function renderTimelineMetaNote(
  doc: TimelineDoc,
  sourceXmlPath: string,
  sourceMtime?: number | null
): string {
  const tlBlock: Record<string, unknown> = {
    enabled: true,
    role: "metadata",
    source_xml: sourceXmlPath,
    version: doc.version ?? null,
    timetype: doc.timetype ?? null,
    xml_attrs: doc.xmlAttrs ?? {},
    xml_extra_nodes: doc.xmlExtraNodes ?? [],
    categories: doc.categories.map(categoryToFrontmatter),
    eras: (doc.eras ?? []).map(eraToFrontmatter),
    view: viewToFrontmatter(doc.view),
  };
  if (sourceMtime != null) tlBlock.last_synced_xml_mtime = sourceMtime;
  const front: Record<string, unknown> = {
    title: "Timeline metadata",
    timeline: tlBlock,
  };
  const yaml = YAML.stringify(front, { lineWidth: 0 });
  const body = [
    "# Timeline metadata",
    "",
    "This note captures non-event timeline XML fields in human-visible YAML.",
    "",
  ].join("\n");
  return `---\n${yaml}---\n\n${body}`;
}

export function parseTimelineMetaNote(raw: string): TimelineMetaNote | undefined {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return undefined;
  let fm: Record<string, unknown>;
  try {
    const parsed: unknown = YAML.parse(m[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    fm = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const tl = fm.timeline;
  if (!tl || typeof tl !== "object" || Array.isArray(tl)) return undefined;
  const timeline = tl as Record<string, unknown>;
  if (timeline.enabled !== true) return undefined;
  if (timeline.role !== "metadata") return undefined;

  const categories = arrayOfObjects(timeline.categories)?.map(frontmatterToCategory) ?? [];
  const eras = arrayOfObjects(timeline.eras)?.map(frontmatterToEra) ?? [];
  const view = frontmatterToView(timeline.view);

  const stamp =
    typeof timeline.last_synced_xml_mtime === "number"
      ? (timeline.last_synced_xml_mtime)
      : undefined;
  return {
    docPatch: {
      version: strOrUndef(timeline.version),
      timetype: strOrUndef(timeline.timetype),
      xmlAttrs: mapOfStrings(timeline.xml_attrs),
      xmlExtraNodes: arrayOfStrings(timeline.xml_extra_nodes),
      categories,
      eras,
      view,
    },
    lastSyncedXmlMtime: stamp,
  };
}

function categoryToFrontmatter(c: TimelineCategory): Record<string, unknown> {
  return {
    name: c.name,
    color: c.color ?? null,
    progress_color: c.progressColor ?? null,
    done_color: c.doneColor ?? null,
    font_color: c.fontColor ?? null,
    parent: c.parent ?? null,
    xml_attrs: c.xmlAttrs ?? {},
    xml_extra_nodes: c.xmlExtraNodes ?? [],
  };
}

function eraToFrontmatter(e: TimelineEra): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    start: toFrontmatterString(e.start),
    end: toFrontmatterString(e.end),
    color: e.color ?? null,
    xml_attrs: e.xmlAttrs ?? {},
    xml_extra_nodes: e.xmlExtraNodes ?? [],
  };
}

function viewToFrontmatter(v: TimelineView | undefined): Record<string, unknown> {
  if (!v) return { displayed_period: null, hidden_categories: [], xml_attrs: {}, xml_extra_nodes: [] };
  return {
    displayed_period: v.displayedPeriod
      ? {
          start: toFrontmatterString(v.displayedPeriod.start),
          end: toFrontmatterString(v.displayedPeriod.end),
        }
      : null,
    hidden_categories: v.hiddenCategories ?? [],
    xml_attrs: v.xmlAttrs ?? {},
    xml_extra_nodes: v.xmlExtraNodes ?? [],
  };
}

function frontmatterToCategory(raw: Record<string, unknown>): TimelineCategory {
  return {
    name: strOrUndef(raw.name) ?? "",
    color: strOrUndef(raw.color),
    progressColor: strOrUndef(raw.progress_color),
    doneColor: strOrUndef(raw.done_color),
    fontColor: strOrUndef(raw.font_color),
    parent: strOrUndef(raw.parent),
    xmlAttrs: mapOfStrings(raw.xml_attrs),
    xmlExtraNodes: arrayOfStrings(raw.xml_extra_nodes),
  };
}

function frontmatterToEra(raw: Record<string, unknown>): TimelineEra {
  const start = parseFrontmatterDate(raw.start) ?? { year: 0, month: 1, day: 1 };
  const end = parseFrontmatterDate(raw.end) ?? { year: 0, month: 1, day: 1 };
  return {
    id: strOrUndef(raw.id) ?? "",
    name: strOrUndef(raw.name) ?? "",
    start,
    end,
    color: strOrUndef(raw.color),
    xmlAttrs: mapOfStrings(raw.xml_attrs),
    xmlExtraNodes: arrayOfStrings(raw.xml_extra_nodes),
  };
}

function frontmatterToView(raw: unknown): TimelineView | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  let displayedPeriod;
  if (v.displayed_period && typeof v.displayed_period === "object" && !Array.isArray(v.displayed_period)) {
    const dp = v.displayed_period as Record<string, unknown>;
    const s = parseFrontmatterDate(dp.start);
    const e = parseFrontmatterDate(dp.end);
    if (s && e) displayedPeriod = { start: s, end: e };
  }
  return {
    displayedPeriod,
    hiddenCategories: arrayOfStrings(v.hidden_categories),
    xmlAttrs: mapOfStrings(v.xml_attrs),
    xmlExtraNodes: arrayOfStrings(v.xml_extra_nodes),
  };
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function arrayOfStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

function arrayOfObjects(v: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(
    (x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
  );
}

function mapOfStrings(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}
