import type {
  EventNote,
  TimelineCategory,
  TimelineDoc,
  TimelineEvent,
} from "./model";

/**
 * Merge a list of Markdown-derived EventNotes into a TimelineDoc skeleton.
 *
 * - Events present in `doc` with a matching id keep their `raw` reference so
 *   unknown XML sub-nodes survive (writer will re-emit them).
 * - Events in MD but not in XML are appended as new.
 * - Events in XML but not in MD are removed (MD is authoritative).
 * - New categories referenced by MD that don't exist are appended with a
 *   sensible default color so the XML stays valid.
 */
export function mergeNotesIntoDoc(
  doc: TimelineDoc,
  notes: EventNote[]
): TimelineDoc {
  const oldById = new Map<string, TimelineEvent>();
  for (const e of doc.events) oldById.set(e.id, e);

  const mergedEvents: TimelineEvent[] = notes.map((n) => {
    const prev = oldById.get(n.event.id);
    if (prev) {
      // Preserve raw subtree so unknown XML survives.
      return { ...n.event, raw: prev.raw };
    }
    return n.event;
  });

  // Categories: keep existing, append any new names referenced by events.
  const existingCatNames = new Set(doc.categories.map((c) => c.name));
  const newCats: TimelineCategory[] = [];
  for (const ev of mergedEvents) {
    if (ev.category && !existingCatNames.has(ev.category)) {
      newCats.push({ name: ev.category, color: "200,200,200" });
      existingCatNames.add(ev.category);
    }
  }

  return {
    ...doc,
    events: mergedEvents,
    categories: [...doc.categories, ...newCats],
  };
}

/** Simple leading-edge debounce — used for vault file-event batching. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  return (...args: A) => {
    lastArgs = args;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
}
