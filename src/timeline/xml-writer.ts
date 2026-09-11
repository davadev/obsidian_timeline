import { XMLBuilder, XMLParser } from "fast-xml-parser";
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
  "container",
  "description",
  "hyperlink",
  "labels",
  "progress",
  "period",
  "show_time",
  "fuzzy_start",
  "fuzzy_end",
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
  const n: RawNode = { [name]: children };
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

const EVENT_DEFAULT_ORDER: ReadonlyArray<string> = [
  "start",
  "end",
  "text",
  "category",
  "container",
  "description",
  "hyperlink",
  "labels",
  "progress",
  "period",
  "show_time",
  "fuzzy_start",
  "fuzzy_end",
  "fuzzy",
  "locked",
  "ends_today",
  "default_color",
  "icon",
  "alert",
];

/**
 * Build the children of an `<event>` node. When the event has a `raw`
 * skeleton from a prior parse, we walk the raw's child order so known fields
 * stay in their original position (no spurious reordering of `labels`,
 * `hyperlink`, etc.) and unknown children survive verbatim.
 */
function buildEventNode(ev: TimelineEvent): RawNode {
  const wantsCData = descriptionWantsCData(ev);
  const hyperlinks = normalizeEventHyperlinks(ev);
  let hyperlinkIdx = 0;
  const synth = (tag: string): RawNode | null => synthesizeEventChild(tag, ev, wantsCData);

  const children: RawNode[] = [];
  const seen = new Set<string>();
  if (ev.raw && typeof ev.raw === "object") {
    for (const child of nodeChildren(ev.raw as RawNode)) {
      const name = nodeName(child);
      if (!name || name === "#text") continue;
      if (name === "hyperlink") {
        if (hyperlinkIdx < hyperlinks.length) {
          children.push(leaf("hyperlink", hyperlinks[hyperlinkIdx++]));
        }
        seen.add("hyperlink");
        continue;
      }
      if (KNOWN_EVENT_TAGS.has(name)) {
        const synthChild = synth(name);
        if (synthChild) {
          children.push(synthChild);
          seen.add(name);
        } else {
          // Field cleared by user — drop it.
          seen.add(name);
        }
      } else {
        // Unknown child — keep as-is.
        children.push(child);
      }
    }
  }
  // Append any known fields the original didn't have.
  for (const tag of EVENT_DEFAULT_ORDER) {
    if (seen.has(tag)) continue;
    if (tag === "hyperlink") {
      if (hyperlinkIdx < hyperlinks.length) {
        children.push(leaf("hyperlink", hyperlinks[hyperlinkIdx++]));
        seen.add(tag);
      }
      continue;
    }
    const c = synth(tag);
    if (c) {
      children.push(c);
      seen.add(tag);
    }
  }
  while (hyperlinkIdx < hyperlinks.length) {
    children.push(leaf("hyperlink", hyperlinks[hyperlinkIdx++]));
  }

  const attrs: Record<string, string> = {};
  if (ev.raw && typeof ev.raw === "object") {
    const rawAttrs = ((ev.raw as RawNode)[":@"] || {});
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  for (const [k, v] of Object.entries(ev.xmlAttrs ?? {})) {
    attrs[k] = v;
  }
  if (!attrs["@_id"]) attrs["@_id"] = ev.id;

  if (!(ev.raw && typeof ev.raw === "object")) {
    for (const n of parseExtraNodes(ev.xmlExtraNodes)) {
      children.push(n);
    }
  }

  return elem("event", children, attrs);
}

function normalizeEventHyperlinks(ev: TimelineEvent): string[] {
  const out = (ev.hyperlinks ?? []).map((s) => s.trim()).filter(Boolean);
  if (!out.length && ev.hyperlink?.trim()) out.push(ev.hyperlink.trim());
  return out;
}

function parseExtraNodes(rawNodes: string[] | undefined): RawNode[] {
  if (!rawNodes || !rawNodes.length) return [];
  const out: RawNode[] = [];
  for (const s of rawNodes) {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as RawNode);
      }
    } catch {
      // Ignore malformed payloads.
    }
  }
  return out;
}

function synthesizeEventChild(
  tag: string,
  ev: TimelineEvent,
  wantsCData: boolean
): RawNode | null {
  switch (tag) {
    case "start":
      return dateLeaf("start", ev.start);
    case "end":
      return dateLeaf("end", ev.end);
    case "text":
      return leaf("text", ev.text);
    case "category":
      return maybeLeaf("category", ev.category);
    case "container":
      return maybeLeaf("container", ev.container);
    case "description":
      if (ev.description == null) return null;
      return wantsCData
        ? cdataLeaf("description", ev.description)
        : leaf("description", ev.description);
    case "hyperlink":
      return maybeLeaf("hyperlink", ev.hyperlink);
    case "labels": {
      if (!ev.labels || !ev.labels.length) return null;
      const tokens = ev.labels.map((l) => l.trim().replace(/\s+/g, "_")).filter(Boolean);
      return leaf("labels", tokens.join(" "));
    }
    case "progress":
      return numLeaf("progress", ev.progress);
    case "period":
      return boolLeaf("period", ev.period);
    case "show_time":
      return boolLeaf("show_time", ev.showTime);
    case "fuzzy_start":
      return boolLeaf("fuzzy_start", ev.fuzzyStart);
    case "fuzzy_end":
      return boolLeaf("fuzzy_end", ev.fuzzyEnd);
    case "fuzzy":
      return boolLeaf("fuzzy", ev.fuzzy);
    case "locked":
      return boolLeaf("locked", ev.locked);
    case "ends_today":
      return boolLeaf("ends_today", ev.endsToday);
    case "default_color":
      return maybeLeaf("default_color", ev.defaultColor);
    case "icon":
      return maybeLeaf("icon", ev.icon);
    case "alert":
      return maybeLeaf("alert", ev.alert);
    default:
      return null;
  }
}

/**
 * Re-emit description as CDATA when the original was CDATA OR the content
 * contains characters that would otherwise force entity encoding (newlines
 * are not technically required to be in CDATA but keeping the form matches
 * what Timeline Project itself writes).
 */
function descriptionWantsCData(ev: TimelineEvent): boolean {
  if (ev.description == null) return false;
  // Was the original wrapped in CDATA?
  if (ev.raw && typeof ev.raw === "object") {
    for (const child of nodeChildren(ev.raw as RawNode)) {
      if (nodeName(child) !== "description") continue;
      for (const sub of nodeChildren(child)) {
        if (nodeName(sub) === "#cdata") return true;
      }
    }
  }
  return /[\n\r<>&]/.test(ev.description);
}

function cdataLeaf(name: string, content: string): RawNode {
  // fast-xml-parser preserveOrder shape for CDATA mirrors the parse output:
  //   { "#cdata": [{ "#text": "..." }] }
  // The builder with cdataPropName: "#cdata" emits a `<![CDATA[...]]>`
  // section. The text node inside carries the literal content.
  return elem(name, [
    { "#cdata": [{ "#text": content }] },
  ]);
}

const CATEGORY_DEFAULT_ORDER: ReadonlyArray<string> = [
  "name",
  "color",
  "progress_color",
  "done_color",
  "font_color",
  "parent",
];

function buildCategoryNode(c: TimelineCategory): RawNode {
  const synth = (tag: string): RawNode | null => {
    switch (tag) {
      case "name":
        return leaf("name", c.name);
      case "color":
        return maybeLeaf("color", c.color);
      case "progress_color":
        return maybeLeaf("progress_color", c.progressColor);
      case "done_color":
        return maybeLeaf("done_color", c.doneColor);
      case "font_color":
        return maybeLeaf("font_color", c.fontColor);
      case "parent":
        return maybeLeaf("parent", c.parent);
      default:
        return null;
    }
  };
  const children: RawNode[] = [];
  const seen = new Set<string>();
  if (c.raw && typeof c.raw === "object") {
    for (const child of nodeChildren(c.raw as RawNode)) {
      const name = nodeName(child);
      if (!name || name === "#text") continue;
      if (KNOWN_CATEGORY_TAGS.has(name)) {
        const synthChild = synth(name);
        if (synthChild) {
          children.push(synthChild);
          seen.add(name);
        } else {
          seen.add(name);
        }
      } else {
        children.push(child);
      }
    }
  }
  for (const tag of CATEGORY_DEFAULT_ORDER) {
    if (seen.has(tag)) continue;
    const c2 = synth(tag);
    if (c2) {
      children.push(c2);
      seen.add(tag);
    }
  }

  const attrs: Record<string, string> = {};
  if (c.raw && typeof c.raw === "object") {
    const rawAttrs = ((c.raw as RawNode)[":@"] || {});
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  for (const [k, v] of Object.entries(c.xmlAttrs ?? {})) {
    attrs[k] = v;
  }
  if (!(c.raw && typeof c.raw === "object")) {
    for (const n of parseExtraNodes(c.xmlExtraNodes)) children.push(n);
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
    const rawAttrs = ((era.raw as RawNode)[":@"] || {});
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  for (const [k, v] of Object.entries(era.xmlAttrs ?? {})) {
    attrs[k] = v;
  }
  if (!(era.raw && typeof era.raw === "object")) {
    for (const n of parseExtraNodes(era.xmlExtraNodes)) children.push(n);
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
  const attrs: Record<string, string> = {};
  if (view.raw && typeof view.raw === "object") {
    const rawAttrs = ((view.raw as RawNode)[":@"] || {});
    for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = v;
  }
  for (const [k, v] of Object.entries(view.xmlAttrs ?? {})) {
    attrs[k] = v;
  }
  if (view.raw && typeof view.raw === "object") {
    for (const u of unknownChildren(view.raw, new Set(["displayed_period", "hidden_categories"]))) {
      children.push(u);
    }
  } else {
    for (const n of parseExtraNodes(view.xmlExtraNodes)) children.push(n);
  }
  return elem("view", children, attrs);
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
  if (!(doc.raw && Array.isArray(doc.raw))) {
    for (const n of parseExtraNodes(doc.xmlExtraNodes)) timelineChildren.push(n);
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
  const timelineAttrs: Record<string, string> = {};
  if (doc.raw && Array.isArray(doc.raw)) {
    const rawRoot = (doc.raw as RawNode[]).find((n) => nodeName(n) === "timeline");
    if (rawRoot) {
      const rawAttrs = ((rawRoot)[":@"] || {});
      for (const [k, v] of Object.entries(rawAttrs)) timelineAttrs[k] = v;
    }
  }
  for (const [k, v] of Object.entries(doc.xmlAttrs ?? {})) timelineAttrs[k] = v;
  tree.push(elem("timeline", timelineChildren, timelineAttrs));

  return builder.build(tree);
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
      out.push({ ...n, [name]: cleaned });
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
  const parser = new XMLParser(PARSER_OPTIONS);
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  const tree = parser.parse(xml) as RawNode[];
  // Decode entities in text nodes before re-emitting — the parser is run with
  // processEntities:false (to dodge fast-xml-parser's entity cap) but the
  // builder is run with processEntities:true, which would otherwise double-
  // escape an already-encoded `&apos;` into `&amp;apos;`.
  decodeTextNodesInPlace(tree);
  const cleaned = stripWhitespaceTextNodes(tree);
  return builder.build(cleaned);
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
