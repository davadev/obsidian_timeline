import { XMLBuilder } from "fast-xml-parser";
import { toXmlString, type TimelineDate } from "./date";
import type {
  TimelineCategory,
  TimelineDoc,
  TimelineEra,
  TimelineEvent,
  TimelineView,
} from "./model";
import { PARSER_OPTIONS, decodeEntities } from "./xml-parser";

/**
 * Browser-safe Timeline Project XML writer.
 *
 * Strategy: rebuild the preserveOrder tree from the semantic model, but for any
 * event/category that still has a `raw` reference and was not flagged as dirty,
 * we keep the original raw node unchanged so unknown sub-elements survive. For
 * dirty/new entities we synthesize the well-known fields and append any preserved
 * unknown children from the original raw if it exists.
 */

type RawNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const KNOWN_EVENT_TAGS = new Set([
  "start",
  "end",
  "text",
  "category",
  "description",
  "hyperlink",
  "labels",
  "progress",
  "fuzzy",
  "locked",
  "ends_today",
  "default_color",
  "icon",
  "alert",
]);

const KNOWN_CATEGORY_TAGS = new Set([
  "name",
  "color",
  "progress_color",
  "done_color",
  "font_color",
  "parent",
]);

const KNOWN_ERA_TAGS = new Set(["name", "start", "end", "color"]);

// Builder needs entity encoding ON so leaf text containing &, <, > round-trips
// to valid XML — the parser disables processEntities to dodge fast-xml-parser's
// 1000-entity expansion guard. We decode entities manually on the read side
// (see xml-parser.ts decodeEntities). Re-enable for the write side here.
const BUILDER_OPTIONS = {
  ...PARSER_OPTIONS,
  format: true,
  indentBy: "  ",
  suppressEmptyNode: false,
  processEntities: true,
} as const;

function textNode(s: string): RawNode {
  return { "#text": s };
}

function elem(name: string, children: RawNode[], attrs?: Record<string, string>): RawNode {
  const n: RawNode = { [name]: children } as RawNode;
  if (attrs && Object.keys(attrs).length) n[":@"] = attrs;
  return n;
}

function leaf(name: string, value: string): RawNode {
  return elem(name, [textNode(value)]);
}

function maybeLeaf(name: string, value: string | undefined): RawNode | null {
  if (value == null) return null;
  return leaf(name, value);
}

function boolLeaf(name: string, v: boolean | undefined): RawNode | null {
  if (v == null) return null;
  return leaf(name, v ? "True" : "False");
}

function numLeaf(name: string, v: number | undefined): RawNode | null {
  if (v == null) return null;
  return leaf(name, String(v));
}

function dateLeaf(name: string, d: TimelineDate): RawNode {
  return leaf(name, toXmlString(d));
}

/** Find name (or null) of the single non-":@" key on a preserveOrder node. */
function nodeName(n: RawNode): string {
  for (const k of Object.keys(n)) if (k !== ":@") return k;
  return "";
}

function nodeChildren(n: RawNode): RawNode[] {
  const name = nodeName(n);
  const v = (n as Record<string, unknown>)[name];
  return Array.isArray(v) ? (v as RawNode[]) : [];
}

/**
 * Extract unknown children (those with names not in `known`) from a raw node.
 * Whitespace-only text nodes inserted by the parser between elements are
 * dropped — the builder re-indents the output on its own.
 */
function unknownChildren(raw: unknown, known: Set<string>): RawNode[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as RawNode;
  return nodeChildren(r).filter((c) => {
    const name = nodeName(c);
    if (!name || name === "#text") return false;
    return !known.has(name);
  });
}

function buildEventNode(ev: TimelineEvent): RawNode {
  const children: RawNode[] = [];
  children.push(dateLeaf("start", ev.start));
  children.push(dateLeaf("end", ev.end));
  children.push(leaf("text", ev.text));
  const cat = maybeLeaf("category", ev.category);
  if (cat) children.push(cat);
  const desc = maybeLeaf("description", ev.description);
  if (desc) children.push(desc);
  const hl = maybeLeaf("hyperlink", ev.hyperlink);
  if (hl) children.push(hl);
  if (ev.labels && ev.labels.length) {
    // Timeline 2.11 expects space-separated tokens. Any whitespace inside a
    // user-typed label is collapsed to an underscore so the round-trip stays
    // parseable.
    const tokens = ev.labels.map((l) => l.trim().replace(/\s+/g, "_")).filter(Boolean);
    children.push(leaf("labels", tokens.join(" ")));
  }
  const prog = numLeaf("progress", ev.progress);
  if (prog) children.push(prog);
  const fuzzy = boolLeaf("fuzzy", ev.fuzzy);
  if (fuzzy) children.push(fuzzy);
  const locked = boolLeaf("locked", ev.locked);
  if (locked) children.push(locked);
  const endsToday = boolLeaf("ends_today", ev.endsToday);
  if (endsToday) children.push(endsToday);
  const dc = maybeLeaf("default_color", ev.defaultColor);
  if (dc) children.push(dc);
  const icon = maybeLeaf("icon", ev.icon);
  if (icon) children.push(icon);
  const alert = maybeLeaf("alert", ev.alert);
  if (alert) children.push(alert);

  // Append preserved unknown children verbatim.
  for (const u of unknownChildren(ev.raw, KNOWN_EVENT_TAGS)) {
    children.push(u);
  }

  // Preserve any attributes from raw (e.g. id) — re-emit semantic id under @_id.
  const attrs: Record<string, string> = {};
  if (ev.raw && typeof ev.raw === "object") {
    const rawAttrs = ((ev.raw as RawNode)[":@"] || {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  if (!attrs["@_id"]) attrs["@_id"] = ev.id;

  return elem("event", children, attrs);
}

function buildCategoryNode(c: TimelineCategory): RawNode {
  const children: RawNode[] = [];
  children.push(leaf("name", c.name));
  const col = maybeLeaf("color", c.color);
  if (col) children.push(col);
  const pcol = maybeLeaf("progress_color", c.progressColor);
  if (pcol) children.push(pcol);
  const dcol = maybeLeaf("done_color", c.doneColor);
  if (dcol) children.push(dcol);
  const fcol = maybeLeaf("font_color", c.fontColor);
  if (fcol) children.push(fcol);
  const par = maybeLeaf("parent", c.parent);
  if (par) children.push(par);
  for (const u of unknownChildren(c.raw, KNOWN_CATEGORY_TAGS)) children.push(u);
  const attrs: Record<string, string> = {};
  if (c.raw && typeof c.raw === "object") {
    const rawAttrs = ((c.raw as RawNode)[":@"] || {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  return elem("category", children, attrs);
}

function buildEraNode(era: TimelineEra): RawNode {
  const children: RawNode[] = [];
  children.push(leaf("name", era.name));
  children.push(dateLeaf("start", era.start));
  children.push(dateLeaf("end", era.end));
  const col = maybeLeaf("color", era.color);
  if (col) children.push(col);
  for (const u of unknownChildren(era.raw, KNOWN_ERA_TAGS)) children.push(u);
  const attrs: Record<string, string> = {};
  if (era.raw && typeof era.raw === "object") {
    const rawAttrs = ((era.raw as RawNode)[":@"] || {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  return elem("era", children, attrs);
}

function buildViewNode(view: TimelineView): RawNode {
  const children: RawNode[] = [];
  if (view.displayedPeriod) {
    children.push(
      elem("displayed_period", [
        dateLeaf("start", view.displayedPeriod.start),
        dateLeaf("end", view.displayedPeriod.end),
      ])
    );
  }
  if (view.hiddenCategories) {
    children.push(
      elem(
        "hidden_categories",
        view.hiddenCategories.map((n) => leaf("name", n))
      )
    );
  }
  return elem("view", children);
}

export function writeTimelineXml(doc: TimelineDoc): string {
  const builder = new XMLBuilder(BUILDER_OPTIONS);

  // Build the timeline root
  const timelineChildren: RawNode[] = [];
  if (doc.version != null) timelineChildren.push(leaf("version", doc.version));
  if (doc.timetype != null) timelineChildren.push(leaf("timetype", doc.timetype));
  timelineChildren.push(
    elem(
      "categories",
      doc.categories.map(buildCategoryNode)
    )
  );
  timelineChildren.push(
    elem(
      "events",
      doc.events.map(buildEventNode)
    )
  );
  if (doc.eras && doc.eras.length) {
    timelineChildren.push(elem("eras", doc.eras.map(buildEraNode)));
  }
  if (doc.view) timelineChildren.push(buildViewNode(doc.view));

  // Preserve top-level unknown children (anything that wasn't version/timetype/categories/events/view)
  if (doc.raw && Array.isArray(doc.raw)) {
    const rawRoot = (doc.raw as RawNode[]).find((n) => nodeName(n) === "timeline");
    if (rawRoot) {
      const known = new Set([
        "version",
        "timetype",
        "categories",
        "events",
        "eras",
        "view",
      ]);
      for (const u of unknownChildren(rawRoot, known)) {
        timelineChildren.push(u);
      }
    }
  }

  // Build outer tree: declaration + timeline
  const tree: RawNode[] = [];
  if (doc.raw && Array.isArray(doc.raw)) {
    for (const n of doc.raw as RawNode[]) {
      const name = nodeName(n);
      if (name === "timeline") continue;
      if (name === "#text") continue; // skip parser whitespace
      tree.push(n); // declaration/PI/comments preserved
    }
  }
  if (!tree.some((n) => nodeName(n) === "?xml")) {
    tree.unshift({
      "?xml": [{ "#text": "" }],
      ":@": { "@_version": "1.0", "@_encoding": "utf-8" },
    });
  }
  tree.push(elem("timeline", timelineChildren));

  return builder.build(tree) as string;
}

/**
 * Walk a preserveOrder tree and drop pure-whitespace text-node siblings (the
 * indentation between elements that the parser preserved). Whitespace inside
 * a leaf element (a node whose only children are text) is left alone so that
 * the XML declaration and elements with meaningful text content survive.
 */
function stripWhitespaceTextNodes(nodes: RawNode[]): RawNode[] {
  // Detect mixed content: if at least one sibling is an element, treat text
  // siblings as inter-element whitespace and drop them when pure-whitespace.
  const hasElement = nodes.some((n) => {
    const name = nodeName(n);
    return name && name !== "#text";
  });
  const out: RawNode[] = [];
  for (const n of nodes) {
    const name = nodeName(n);
    if (name === "#text") {
      if (hasElement) {
        const t = (n as Record<string, unknown>)["#text"];
        if (typeof t === "string" && t.trim() === "") continue;
      }
      out.push(n);
      continue;
    }
    const kids = nodeChildren(n);
    if (kids.length) {
      const cleaned = stripWhitespaceTextNodes(kids);
      out.push({ ...n, [name]: cleaned } as RawNode);
    } else {
      out.push(n);
    }
  }
  return out;
}

/**
 * Canonical normalization: parse, strip whitespace text nodes, and re-emit so
 * any two inputs that mean the same thing produce identical strings. Used by
 * the round-trip test instead of strict byte-equality.
 */
export function canonicalizeXml(xml: string): string {
  const { XMLParser } = require("fast-xml-parser") as typeof import("fast-xml-parser");
  const parser = new XMLParser(PARSER_OPTIONS);
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  const tree = parser.parse(xml) as RawNode[];
  // Decode entities in text nodes before re-emitting — the parser is run with
  // processEntities:false (to dodge fast-xml-parser's entity cap) but the
  // builder is run with processEntities:true, which would otherwise double-
  // escape an already-encoded `&apos;` into `&amp;apos;`.
  decodeTextNodesInPlace(tree);
  const cleaned = stripWhitespaceTextNodes(tree);
  return builder.build(cleaned) as string;
}

function decodeTextNodesInPlace(nodes: RawNode[]): void {
  for (const n of nodes) {
    for (const key of Object.keys(n)) {
      if (key === ":@") continue;
      if (key === "#text") {
        const v = (n as Record<string, unknown>)[key];
        if (typeof v === "string") (n as Record<string, unknown>)[key] = decodeEntities(v);
        continue;
      }
      const v = (n as Record<string, unknown>)[key];
      if (Array.isArray(v)) decodeTextNodesInPlace(v as RawNode[]);
    }
  }
}
