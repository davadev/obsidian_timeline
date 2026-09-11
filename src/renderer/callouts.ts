/**
 * Placement for events whose bar is too short to hold their own name.
 *
 * At any zoom out far enough, a battle that lasted a day and every point event
 * collapses to a few pixels, and the chart shows a coloured speck with no text
 * — the timeline stops telling you what it is made of. This puts the name
 * *beside* the speck, in the same lane, joined to it by a short leader, so the
 * association stays obvious and nothing has to move.
 *
 * Two other shapes were prototyped and rejected by looking at them: a rail of
 * names under the chart (leaders grow long, cross bars, and it costs vertical
 * room on a phone) and boxed callouts placed in the nearest free space (heavier
 * on screen, and a box can drift into a neighbouring lane, which reads as
 * belonging to the wrong row).
 *
 * Pure maths in pixels along the time axis: no DOM, so it is the same code for
 * horizontal and vertical and can be tested directly.
 */

import { FALLBACK_CHAR_WIDTH, type Measure } from "./text-metrics";

export interface CalloutItem {
  id: string;
  text: string;
  lane: number;
  /** Position along the time axis, in px. Equal for a point. */
  startPx: number;
  endPx: number;
  isPoint: boolean;
}

/** A stretch of a lane that is already painted, in time-axis px. */
export interface LaneSpan {
  lane: number;
  from: number;
  to: number;
}

export interface Callout {
  id: string;
  lane: number;
  /** Where the text begins (its leading edge along the time axis). */
  textPx: number;
  /** Where the leader meets the event. */
  anchorPx: number;
  /** `after` = the name sits later in time than the event, `before` = earlier. */
  side: "after" | "before";
  /** Possibly truncated to the room available. */
  label: string;
  widthPx: number;
}

export interface CalloutOptions {
  /** Width of a label in the font it will be drawn in. */
  measure?: Measure;
  /** Fallback average glyph width, used when nothing can measure text. */
  charWidth?: number;
  /** Clearance kept either side of a placed name. */
  gap?: number;
  /** Length of the leader between the event and its name. */
  leader?: number;
  /** Below this many characters a name is not worth placing. */
  minChars?: number;
  /** Radius of a point marker, so its name clears the dot. */
  pointRadius?: number;
  /** Names are kept this far inside the pane. */
  edgePad?: number;
}

const DEFAULTS = {
  charWidth: FALLBACK_CHAR_WIDTH,
  gap: 6,
  leader: 9,
  minChars: 5,
  pointRadius: 7,
  edgePad: 2,
};

/**
 * Names for `items`, packed into the free space of their own lanes.
 *
 * `occupied` is everything already painted — every visible bar and point,
 * including the ones that did get a name inside them (an in-bar label never
 * reaches past its own bar, so the bar's extent covers it).
 *
 * Shortest events are placed first: when two names compete for one gap, the
 * one whose own bar can never hold it has the stronger claim.
 */
export function layoutCallouts(
  items: CalloutItem[],
  occupied: LaneSpan[],
  paneSize: number,
  options: CalloutOptions = {}
): Callout[] {
  const o = { ...DEFAULTS, ...options };
  const measure: Measure =
    o.measure ?? ((text: string) => text.length * o.charWidth);
  const lanes = new Map<number, Array<[number, number]>>();
  for (const s of occupied) {
    const list = lanes.get(s.lane) ?? [];
    list.push([s.from, s.to]);
    lanes.set(s.lane, list);
  }

  const out: Callout[] = [];
  const order = [...items].sort(
    (a, b) => a.endPx - a.startPx - (b.endPx - b.startPx)
  );

  for (const item of order) {
    const taken = lanes.get(item.lane) ?? [];
    const after = item.isPoint ? item.startPx + o.pointRadius : item.endPx;
    const before = item.isPoint ? item.startPx - o.pointRadius : item.startPx;

    // Room is measured against the neighbouring bars only, never against the
    // edge of the pane. The distance between two events is fixed at a given
    // zoom, so a name shortened by its neighbour keeps the same text however
    // the chart is scrolled; a name shortened by the pane edge would re-cut
    // itself on every frame — "Yalta conference" flickering through "Yalta
    // con…" and back as it drifted towards the edge.
    const placement =
      tryside("after", after + o.leader, taken, item, o, measure, paneSize) ??
      tryside("before", before - o.leader, taken, item, o, measure, paneSize);
    if (!placement) continue; // no honest place for it; scrolling makes one

    taken.push([
      placement.textPx - o.gap,
      placement.textPx + placement.widthPx + o.gap,
    ]);
    lanes.set(item.lane, taken);
    out.push({
      id: item.id,
      lane: item.lane,
      anchorPx: placement.side === "after" ? after : before,
      ...placement,
    });
  }

  // Back into reading order, so the drawn output does not depend on which
  // event happened to be shortest.
  return out.sort((a, b) => a.textPx - b.textPx);
}

/**
 * One side's attempt: how much room the neighbours leave, what text fits it,
 * and whether the result lands inside the pane.
 *
 * A name that would be cut by the pane edge is refused rather than shortened —
 * the event is a few pixels from the edge and is about to be scrolled clear of
 * it, at which point the name appears whole and stays that way.
 */
function tryside(
  side: "after" | "before",
  edge: number,
  taken: Array<[number, number]>,
  item: CalloutItem,
  o: Required<Omit<CalloutOptions, "measure">>,
  measure: Measure,
  paneSize: number
): { side: "after" | "before"; textPx: number; label: string; widthPx: number } | null {
  if (covers(taken, edge)) return null;

  let room = Number.POSITIVE_INFINITY;
  if (side === "after") {
    let end = Number.POSITIVE_INFINITY;
    for (const [from] of taken) {
      if (from >= edge && from - o.gap < end) end = from - o.gap;
    }
    room = end - edge;
  } else {
    let start = Number.NEGATIVE_INFINITY;
    for (const [, to] of taken) {
      if (to <= edge && to + o.gap > start) start = to + o.gap;
    }
    room = edge - start;
  }

  const least = measure(`${item.text.slice(0, o.minChars)}…`);
  if (room < Math.min(measure(item.text), least)) return null;

  const label = fit(item.text, room, measure);
  if (!label) return null;
  const widthPx = measure(label);
  const textPx = side === "after" ? edge : edge - widthPx;
  if (textPx < o.edgePad || textPx + widthPx > paneSize - o.edgePad) return null;
  return { side, textPx, label, widthPx };
}

/** True when `x` falls inside something already painted in this lane. */
function covers(spans: Array<[number, number]>, x: number): boolean {
  return spans.some(([from, to]) => from <= x && x <= to);
}

/** The longest prefix of `text` that fits `room`, ellipsised when it is cut. */
function fit(text: string, room: number, measure: Measure): string {
  if (measure(text) <= room) return text;
  let lo = 1;
  let hi = text.length - 1;
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = `${text.slice(0, mid)}…`;
    if (measure(candidate) <= room) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
