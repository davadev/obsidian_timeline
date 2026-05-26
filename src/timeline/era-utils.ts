import type { ViewportRange } from "./overlap";
import type { TimelineEra } from "./model";

/**
 * Drop eras whose date range doesn't overlap the visible viewport.
 * Era ranges are inclusive on both ends — a viewport ending at year 1000
 * still includes an era starting in 1000.
 */
export function filterErasToViewport(
  eras: TimelineEra[] | undefined,
  vp: ViewportRange | null | undefined
): TimelineEra[] | undefined {
  if (!eras) return eras;
  if (!vp) return eras;
  return eras.filter(
    (e) => e.start.year <= vp.end.year && e.end.year >= vp.start.year
  );
}

interface YMD {
  year: number;
  month?: number;
  day?: number;
}

/**
 * Smallest viewport that covers every event. Year/month/day-aware. Eras are
 * intentionally NOT considered — eras are background bands sized to match
 * whatever events the user is currently looking at; including them in
 * viewport derivation would make a single-point event note auto-zoom to span
 * the full Iron Age (or similar).
 */
export function autoViewportFromEvents<E extends { start: YMD; end: YMD }>(
  events: E[]
): ViewportRange | undefined {
  if (!events.length) return undefined;
  let start: YMD = events[0].start;
  let end: YMD = events[0].end;
  for (const e of events) {
    if (compareYMD(e.start, start) < 0) start = e.start;
    if (compareYMD(e.end, end) > 0) end = e.end;
  }
  return { start, end };
}

function compareYMD(a: YMD, b: YMD): number {
  if (a.year !== b.year) return a.year - b.year;
  if ((a.month ?? 1) !== (b.month ?? 1)) return (a.month ?? 1) - (b.month ?? 1);
  return (a.day ?? 1) - (b.day ?? 1);
}
