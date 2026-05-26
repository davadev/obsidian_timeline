import YAML from "yaml";
import type { TimelineEra } from "./model";
import { parseFrontmatterDate, type TimelineDate } from "./date";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a Markdown note as a TimelineEra when its frontmatter declares
 * `timeline.role: era` and `timeline.enabled: true`. Returns null otherwise.
 *
 * Era MD notes are not part of the rich event sync path — they're a thin
 * mirror of the XML <era> data that the user can edit through the inspector.
 * The inspector writes back via {@link renderEraMarkdown} and the cache
 * picks them up alongside events in `getMdDoc` / `getRenderDoc`.
 */
export function parseEraNote(raw: string, fallbackId: string): TimelineEra | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  let fm: Record<string, unknown>;
  try {
    const p = YAML.parse(m[1]);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    fm = p as Record<string, unknown>;
  } catch {
    return null;
  }
  const tl = fm.timeline as Record<string, unknown> | undefined;
  if (!tl || typeof tl !== "object" || Array.isArray(tl)) return null;
  if (tl.enabled !== true) return null;
  if (tl.role !== "era") return null;

  const idRaw = typeof tl.era_id === "string" ? tl.era_id.trim() : "";
  const id = idRaw || fallbackId;
  const name =
    (typeof fm.title === "string" && fm.title.trim()) ||
    (typeof tl.name === "string" && (tl.name as string).trim()) ||
    fallbackId;

  const start = readDate(tl.start);
  const end = readDate(tl.end);
  if (!start || !end) return null;
  const color = typeof tl.color === "string" && (tl.color as string).trim()
    ? (tl.color as string).trim()
    : undefined;
  const stampRaw = tl.last_synced_xml_mtime;
  const lastSyncedXmlMtime =
    typeof stampRaw === "number" && Number.isFinite(stampRaw)
      ? stampRaw
      : undefined;
  return { id, name, start, end, color, lastSyncedXmlMtime };
}

export function renderEraMarkdown(
  era: TimelineEra,
  timelineId: string,
  sourceXmlPath: string,
  sourceMtime?: number | null
): string {
  const fmStart = formatDate(era.start);
  const fmEnd = formatDate(era.end);
  const stamp = sourceMtime ?? era.lastSyncedXmlMtime ?? null;
  const stampLine = stamp != null ? `  last_synced_xml_mtime: ${stamp}\n` : "";
  return `---
title: ${escapeYaml(era.name)}
tags:
  - Timeline
  - Era

timeline:
  enabled: true
  id: ${timelineId}
  era_id: ${escapeYaml(era.id)}
  role: era
  source_xml: ${sourceXmlPath}
  color: ${escapeYaml(era.color ?? "")}
  start:
    year: ${era.start.year}
    month: ${nullOr(era.start.month)}
    day: ${nullOr(era.start.day)}
  end:
    year: ${era.end.year}
    month: ${nullOr(era.end.month)}
    day: ${nullOr(era.end.day)}
${stampLine}
timeline_era_start: ${fmStart}
timeline_era_end: ${fmEnd}
timeline_era_color: ${escapeYaml(era.color ?? "")}
timeline_role: era
---

# ${era.name}

> Era / background band. Edits made in the Timeline inspector are saved
> here as the source of truth and propagate to the XML on the next sync.
>
> Range: \`${fmStart}\` → \`${fmEnd}\`
${era.color ? `> Color: \`${era.color}\`` : ""}
`;
}

function readDate(raw: unknown): TimelineDate | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.year !== "number" || !Number.isInteger(o.year)) return null;
    return {
      year: o.year,
      month: intOrUndef(o.month),
      day: intOrUndef(o.day),
      hour: intOrUndef(o.hour),
      minute: intOrUndef(o.minute),
      second: intOrUndef(o.second),
    };
  }
  return parseFrontmatterDate(raw);
}

function intOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

function nullOr(v: number | undefined): string {
  return v == null ? "null" : String(v);
}

function formatDate(d: TimelineDate): string {
  const pad = (n?: number) => (n == null ? "01" : String(n).padStart(2, "0"));
  const yr = String(Math.abs(d.year)).padStart(4, "0");
  return `${d.year < 0 ? "-" : ""}${yr}-${pad(d.month)}-${pad(d.day)}`;
}

function escapeYaml(s: string): string {
  if (!s) return '""';
  // Quote when the string contains anything YAML might treat specially.
  if (/[:#&*!?{}\[\],"'|>%@`]/.test(s) || /^[-?\s]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}
