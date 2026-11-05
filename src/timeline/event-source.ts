import { toXmlString } from "./date";
import type { TimelineEvent } from "./model";

/**
 * Canonical text of the XML-side content of an event: what a note is a copy of
 * when import writes it. Import stores a fingerprint of this in the note, so a
 * later import can tell "the XML changed since this note was written" from "the
 * note was edited", which together are a conflict.
 */
export function eventSourceKey(ev: TimelineEvent): string {
  const norm = {
    text: ev.text.trim(),
    start: toXmlString(ev.start),
    end: toXmlString(ev.end),
    category: ev.category?.trim() ?? null,
    container: ev.container?.trim() ?? null,
    description: ev.description?.trim() ?? null,
    hyperlinks: (ev.hyperlinks ?? []).map((h) => h.trim()),
    labels: ev.labels ?? [],
    progress: ev.progress ?? null,
    flags: [ev.period, ev.showTime, ev.fuzzyStart, ev.fuzzyEnd, ev.fuzzy, ev.locked, ev.endsToday].map((f) => f ?? null),
    defaultColor: ev.defaultColor ?? null,
    icon: ev.icon ?? null,
    alert: ev.alert ?? null,
  };
  return JSON.stringify(norm);
}
