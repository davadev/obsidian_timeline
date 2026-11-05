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

  const merged: TimelineEvent[] = notes.map((n) => {
    const prev = oldById.get(n.event.id);
    if (prev) {
      // Preserve raw subtree so unknown XML survives.
      return { ...n.event, raw: prev.raw };
    }
    return n.event;
  });
  // Keep the XML's own event order, new events last. Notes arrive in whatever
  // order the vault lists files, and a reshuffled file is a changed file: it
  // makes a sync client upload it and every other device see an edit.
  const position = new Map<string, number>();
  doc.events.forEach((e, i) => position.set(e.id, i));
  const mergedEvents = merged
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        (position.get(a.e.id) ?? Infinity) - (position.get(b.e.id) ?? Infinity) ||
        a.i - b.i
    )
    .map((x) => x.e);

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
  let t: number | null = null;
  return (...args: A) => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}
