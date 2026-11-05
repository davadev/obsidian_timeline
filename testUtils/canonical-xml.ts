import XMLBuilder from "fast-xml-builder";
import { XMLParser } from "fast-xml-parser";
import { PARSER_OPTIONS, decodeEntities } from "../src/timeline/xml-parser";

type RawNode = Record<string, unknown> & { ":@"?: Record<string, string> };

// Same shape as the writer's builder, so two inputs that mean the same thing
// come out as the same string.
const BUILDER_OPTIONS = {
  ...PARSER_OPTIONS,
  format: true,
  indentBy: "  ",
  suppressEmptyNode: false,
  processEntities: true,
} as const;

function nodeName(n: RawNode): string {
  return Object.keys(n).find((k) => k !== ":@") as string;
}

function nodeChildren(n: RawNode): RawNode[] {
  return (n as Record<string, unknown>)[nodeName(n)] as RawNode[];
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
