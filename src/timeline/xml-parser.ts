import { XMLParser } from "fast-xml-parser";
import { parseXmlDate, type TimelineDate } from "./date";
import type {
  TimelineCategory,
  TimelineDoc,
  TimelineEra,
  TimelineEvent,
  TimelineView,
} from "./model";
import { slugify, uniqueSlug } from "./id-utils";

/**
 * Browser-safe Timeline Project XML parser.
 *
 * Uses fast-xml-parser in preserveOrder mode so the full document tree is kept as
 * an opaque skeleton (TimelineDoc.raw / TimelineEvent.raw). Unknown elements,
 * attribute values, and child ordering survive a round-trip even though the
 * semantic model only exposes a curated set of well-known fields.
 */

export const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // Disable fast-xml-parser's built-in entity processing. The library has a
  // hardcoded ~1000-entity expansion cap (anti-billion-laughs), and after a
  // round-trip our descriptions can easily emit more than that — Timeline
  // 2.11 serializes newlines as numeric entities (&#10;) which blew past the
  // limit on mobile (error: "Entity expansion limit exceeded: 1003 > 1000").
  // We decode the few entities we actually care about ourselves in textOf /
  // deepTextOf, so attributes and structure are preserved either way.
  processEntities: false,
  // keep XML declaration nodes
  ignoreDeclaration: false,
  // Preserve CDATA sections under a dedicated key so deepTextOf can pull
  // their content out — Timeline Project sometimes wraps descriptions /
  // hyperlinks in CDATA which would otherwise vanish in the default config.
  cdataPropName: "#cdata",
} as const;

/**
 * Decode the entity references that appear in Timeline XML text content.
 * Supports the five named XML entities plus numeric `&#NN;` / `&#xNN;`.
 * Anything we don't recognise is left untouched.
 */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf("&") === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const codepoint = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codepoint) || codepoint < 0 || codepoint > 0x10ffff) {
        return full;
      }
      try {
        return String.fromCodePoint(codepoint);
      } catch {
        return full;
      }
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return full;
    }
  });
}

/** preserveOrder=true: each node is a single-key object; attributes live on ":@" sibling. */
type RawNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const TEXT_KEY = "#text";

function isRawNode(x: unknown): x is RawNode {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function nodeName(n: RawNode): string {
  for (const k of Object.keys(n)) {
    if (k !== ":@") return k;
  }
  return "";
}

function nodeChildren(n: RawNode): RawNode[] {
  const name = nodeName(n);
  const v = (n as Record<string, unknown>)[name];
  return Array.isArray(v) ? (v as RawNode[]) : [];
}

/**
 * Concatenate direct #text children into a string.
 * Use {@link deepTextOf} when an element may have inline children (br/i/b/a).
 */
function textOf(children: RawNode[]): string {
  let out = "";
  for (const c of children) {
    const t = (c as Record<string, unknown>)[TEXT_KEY];
    if (typeof t === "string") out += t;
  }
  return decodeEntities(out);
}

/**
 * Recursively collect text content across nested inline elements. Required for
 * Timeline Project descriptions which often contain inline HTML (br/i/b/a) —
 * the plain textOf would drop everything after the first inline child.
 */
function deepTextOf(children: RawNode[]): string {
  let out = "";
  for (const c of children) {
    const name = nodeName(c);
    if (name === "#text" || name === "") {
      const t = (c as Record<string, unknown>)[TEXT_KEY];
      if (typeof t === "string") out += decodeEntities(t);
      continue;
    }
    if (name === "#cdata") {
      const v = (c as Record<string, unknown>)["#cdata"];
      if (typeof v === "string") out += v; // CDATA content is verbatim, no entity decode
      else if (Array.isArray(v)) {
        for (const item of v) {
          const t = (item as Record<string, unknown>)?.[TEXT_KEY];
          if (typeof t === "string") out += t;
        }
      }
      continue;
    }
    const kids = nodeChildren(c);
    if (name === "br") {
      out += "\n";
      continue;
    }
    out += deepTextOf(kids);
  }
  return out;
}

function findChild(children: RawNode[], name: string): RawNode | undefined {
  for (const c of children) if (nodeName(c) === name) return c;
  return undefined;
}

function findAllChildren(children: RawNode[], name: string): RawNode[] {
  return children.filter((c) => nodeName(c) === name);
}

function readText(parent: RawNode[], tag: string): string | undefined {
  const node = findChild(parent, tag);
  if (!node) return undefined;
  return textOf(nodeChildren(node));
}

function readDeepText(parent: RawNode[], tag: string): string | undefined {
  const node = findChild(parent, tag);
  if (!node) return undefined;
  return deepTextOf(nodeChildren(node));
}

function readBool(parent: RawNode[], tag: string): boolean | undefined {
  const v = readText(parent, tag);
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

function readNumber(parent: RawNode[], tag: string): number | undefined {
  const v = readText(parent, tag);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readDate(parent: RawNode[], tag: string): TimelineDate | undefined {
  const v = readText(parent, tag);
  if (v == null) return undefined;
  return parseXmlDate(v) ?? undefined;
}

export function parseTimelineXml(xml: string): TimelineDoc {
  const parser = new XMLParser(PARSER_OPTIONS);
  const tree = parser.parse(xml) as RawNode[];

  // Locate <timeline> root, skipping declaration/PI nodes.
  const timelineNode = tree.find((n) => nodeName(n) === "timeline");
  if (!timelineNode) {
    throw new Error("Invalid Timeline XML: missing <timeline> root element");
  }
  const root = nodeChildren(timelineNode);

  const version = readText(root, "version");
  const timetype = readText(root, "timetype");

  // Categories
  const categoriesNode = findChild(root, "categories");
  const categories: TimelineCategory[] = [];
  if (categoriesNode) {
    for (const c of findAllChildren(nodeChildren(categoriesNode), "category")) {
      const ch = nodeChildren(c);
      const cat: TimelineCategory = {
        name: readText(ch, "name") ?? "",
        color: readText(ch, "color"),
        progressColor: readText(ch, "progress_color"),
        doneColor: readText(ch, "done_color"),
        fontColor: readText(ch, "font_color"),
        parent: readText(ch, "parent"),
        raw: c,
      };
      categories.push(cat);
    }
  }

  // Events
  const eventsNode = findChild(root, "events");
  const events: TimelineEvent[] = [];
  const usedIds = new Set<string>();
  if (eventsNode) {
    for (const e of findAllChildren(nodeChildren(eventsNode), "event")) {
      const ch = nodeChildren(e);
      const text = readText(ch, "text") ?? "";
      const start = readDate(ch, "start");
      const end = readDate(ch, "end");
      if (!start || !end) continue; // skip malformed
      const idAttr = (e[":@"] && (e[":@"] as Record<string, string>)["@_id"]) || undefined;
      const baseId = idAttr || slugify(text || "event");
      const id = uniqueSlug(baseId, usedIds);
      const ev: TimelineEvent = {
        id,
        text,
        start,
        end,
        isPoint:
          start.year === end.year &&
          start.month === end.month &&
          start.day === end.day &&
          start.hour === end.hour &&
          start.minute === end.minute &&
          start.second === end.second,
        category: readText(ch, "category"),
        description: readDeepText(ch, "description"),
        hyperlink: readText(ch, "hyperlink"),
        labels: parseLabels(readText(ch, "labels")),
        progress: readNumber(ch, "progress"),
        fuzzy: readBool(ch, "fuzzy"),
        locked: readBool(ch, "locked"),
        endsToday: readBool(ch, "ends_today"),
        defaultColor: readText(ch, "default_color"),
        icon: readText(ch, "icon"),
        alert: readText(ch, "alert"),
        raw: e,
      };
      events.push(ev);
    }
  }

  // Eras (Timeline Project's coloured background bands)
  const erasNode = findChild(root, "eras");
  const eras: TimelineEra[] = [];
  const usedEraIds = new Set<string>();
  if (erasNode) {
    for (const eraNode of findAllChildren(nodeChildren(erasNode), "era")) {
      const ch = nodeChildren(eraNode);
      const name = readText(ch, "name") ?? "";
      const start = readDate(ch, "start");
      const end = readDate(ch, "end");
      if (!start || !end) continue;
      const baseId = slugify(name || "era");
      const id = uniqueSlug(baseId, usedEraIds);
      eras.push({
        id,
        name,
        start,
        end,
        color: readText(ch, "color"),
        raw: eraNode,
      });
    }
  }

  // View
  const viewNode = findChild(root, "view");
  let view: TimelineView | undefined;
  if (viewNode) {
    const ch = nodeChildren(viewNode);
    const dp = findChild(ch, "displayed_period");
    let displayedPeriod;
    if (dp) {
      const dpCh = nodeChildren(dp);
      const s = readDate(dpCh, "start");
      const e = readDate(dpCh, "end");
      if (s && e) displayedPeriod = { start: s, end: e };
    }
    const hc = findChild(ch, "hidden_categories");
    let hiddenCategories: string[] | undefined;
    if (hc) {
      hiddenCategories = findAllChildren(nodeChildren(hc), "name").map((n) =>
        textOf(nodeChildren(n))
      );
    }
    view = { displayedPeriod, hiddenCategories, raw: viewNode };
  }

  return {
    version,
    timetype,
    categories,
    events,
    eras,
    view,
    raw: tree,
  };
}

/**
 * Timeline Project 2.11 serialises labels as space-separated tokens. Older
 * dumps occasionally used ";" or "," (or the user pasted a comma list).
 * Accept all of them; writer always emits the canonical space form.
 */
function parseLabels(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
