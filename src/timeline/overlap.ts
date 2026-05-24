import { compare, type TimelineDate } from "./date";
import type { TimelineEvent } from "./model";

export interface ViewportRange {
  start: TimelineDate;
  end: TimelineDate;
}

/** Whether the event intersects the viewport (inclusive). Handles point events. */
export function eventOverlapsViewport(
  ev: TimelineEvent,
  vp: ViewportRange
): boolean {
  if (ev.isPoint) {
    return compare(ev.start, vp.start) >= 0 && compare(ev.start, vp.end) <= 0;
  }
  return compare(ev.start, vp.end) <= 0 && compare(ev.end, vp.start) >= 0;
}

/** Filter events to those overlapping viewport. Stable order. */
export function eventsInViewport(
  events: TimelineEvent[],
  vp: ViewportRange
): TimelineEvent[] {
  return events.filter((e) => eventOverlapsViewport(e, vp));
}

/**
 * Greedy lane assignment for bar rendering. Events sorted by start; each event
 * gets the lowest-index lane whose last end < event.start.
 * Returns an array parallel to `events` (in original order).
 */
export function assignLanes(events: TimelineEvent[]): number[] {
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => compare(a.e.start, b.e.start));
  const laneEnds: TimelineDate[] = [];
  const out: number[] = new Array(events.length).fill(0);
  for (const { e, i } of indexed) {
    let placed = -1;
    for (let l = 0; l < laneEnds.length; l++) {
      if (compare(laneEnds[l], e.start) < 0) {
        placed = l;
        break;
      }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(e.end);
    } else {
      laneEnds[placed] = e.end;
    }
    out[i] = placed;
  }
  return out;
}
