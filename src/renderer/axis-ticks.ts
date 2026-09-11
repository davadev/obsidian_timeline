import {
  fractionalPosition,
  fromJulian,
  toJulian,
  type TimelineDate,
} from "../timeline/date";

/**
 * Axis tick selection.
 *
 * The axis used to draw a fixed 4-16 ticks spread evenly across the viewport,
 * labelled with a rounded year. Zoomed in, that meant thousands of pixels
 * between marks, all reading the same year — no way to tell where you were.
 *
 * Ticks are now placed on real calendar boundaries (a century, a year, the
 * first of a month, a day) chosen so neighbouring marks land roughly
 * `targetSpacingPx` apart. Zoom in far enough and the axis starts naming
 * months, then days.
 */

export type TickUnit = "year" | "month" | "day";

export interface AxisTick {
  /** Position along the axis, 0..1 of the viewport. */
  t: number;
  label: string;
}

export interface TickStep {
  unit: TickUnit;
  count: number;
}

/** Coarse to fine. Each entry must divide its unit's range sensibly. */
const STEPS: TickStep[] = [
  { unit: "year", count: 5000 },
  { unit: "year", count: 2000 },
  { unit: "year", count: 1000 },
  { unit: "year", count: 500 },
  { unit: "year", count: 200 },
  { unit: "year", count: 100 },
  { unit: "year", count: 50 },
  { unit: "year", count: 20 },
  { unit: "year", count: 10 },
  { unit: "year", count: 5 },
  { unit: "year", count: 2 },
  { unit: "year", count: 1 },
  { unit: "month", count: 6 },
  { unit: "month", count: 3 },
  { unit: "month", count: 1 },
  { unit: "day", count: 10 },
  { unit: "day", count: 5 },
  { unit: "day", count: 2 },
  { unit: "day", count: 1 },
];

const DAYS_PER_YEAR = 365.2425;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Never emit more than this many ticks, however extreme the zoom. */
const MAX_TICKS = 600;

/** Approximate length of one step, in days. */
export function stepDays(step: TickStep): number {
  switch (step.unit) {
    case "year":
      return step.count * DAYS_PER_YEAR;
    case "month":
      return (step.count * DAYS_PER_YEAR) / 12;
    default:
      return step.count;
  }
}

/**
 * Finest step whose marks would still sit at least `targetSpacingPx` apart.
 * Falls back to the coarsest step when even that is too dense.
 */
export function pickStep(
  spanDays: number,
  axisPx: number,
  targetSpacingPx: number
): TickStep {
  const pxPerDay = axisPx / Math.max(spanDays, 1e-6);
  let chosen = STEPS[0];
  for (const step of STEPS) {
    if (stepDays(step) * pxPerDay >= targetSpacingPx) chosen = step;
  }
  return chosen;
}

/** Ticks for a viewport, on real calendar boundaries. */
export function axisTicks(
  start: TimelineDate,
  end: TimelineDate,
  axisPx: number,
  targetSpacingPx: number
): AxisTick[] {
  const spanDays = toJulian(end) - toJulian(start);
  if (!(spanDays > 0) || !(axisPx > 0)) return [];

  const step = pickStep(spanDays, axisPx, targetSpacingPx);
  const ticks: AxisTick[] = [];

  for (const date of boundaries(start, end, step)) {
    ticks.push({
      t: fractionalPosition(date, start, end),
      label: formatTick(date, step.unit),
    });
    if (ticks.length >= MAX_TICKS) break;
  }
  return ticks;
}

/** Every calendar boundary of `step` inside [start, end]. */
function* boundaries(
  start: TimelineDate,
  end: TimelineDate,
  step: TickStep
): Generator<TimelineDate> {
  const endJ = toJulian(end);

  if (step.unit === "year") {
    const first = alignDown(start.year, step.count);
    for (let y = first; ; y += step.count) {
      const d: TimelineDate = { year: y, month: 1, day: 1 };
      const j = toJulian(d);
      if (j > endJ) return;
      if (j >= toJulian(start)) yield d;
    }
  }

  if (step.unit === "month") {
    const startMonth = start.month ?? 1;
    let y = start.year;
    let m = alignDown(startMonth - 1, step.count) + 1;
    for (;;) {
      const d: TimelineDate = { year: y, month: m, day: 1 };
      const j = toJulian(d);
      if (j > endJ) return;
      if (j >= toJulian(start)) yield d;
      m += step.count;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }
  }

  if (step.unit === "day") {
    // Walk real days so month lengths and leap years look after themselves.
    let y = start.year;
    let m = start.month ?? 1;
    let day = alignDown((start.day ?? 1) - 1, step.count) + 1;
    for (;;) {
      const d: TimelineDate = { year: y, month: m, day };
      const j = toJulian(d);
      if (j > endJ) return;
      if (j >= toJulian(start)) yield d;
      day += step.count;
      const len = daysInMonth(y, m);
      if (day > len) {
        day -= len;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
  }
}

function alignDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function formatTick(d: TimelineDate, unit: TickUnit): string {
  const year = d.year < 0 ? `${-d.year} BCE` : String(d.year);
  if (unit === "year") return year;
  const month = MONTHS[(d.month ?? 1) - 1];
  if (unit === "month") return `${month} ${year}`;
  return `${d.day ?? 1} ${month} ${year}`;
}


/**
 * Ticks for the slice of the axis currently on screen.
 *
 * Labelling the whole axis does not scale: zoomed in far enough to name months
 * across two millennia, a full pass would emit tens of thousands of nodes, and
 * any cap on that count silently truncates the far end of the timeline. This
 * generates marks for `[viewFromPx, viewToPx]` only, so the step reflects what
 * the user is actually looking at and the node count stays flat at any zoom.
 *
 * Positions come back in absolute axis pixels.
 */
export function visibleAxisTicks(
  start: TimelineDate,
  end: TimelineDate,
  axisPx: number,
  viewFromPx: number,
  viewToPx: number,
  targetSpacingPx: number
): { px: number; label: string }[] {
  if (!(axisPx > 0)) return [];

  const startJ = toJulian(start);
  const endJ = toJulian(end);
  const spanJ = endJ - startJ;
  if (!(spanJ > 0)) return [];

  // A full screen of margin either side: the painter only refreshes when the
  // scroll leaves what is painted or comes to rest, so the marks have to
  // survive a decent flick without a repaint.
  const margin = Math.max(targetSpacingPx * 2, viewToPx - viewFromPx);
  const fromPx = Math.max(0, viewFromPx - margin);
  const toPx = Math.min(axisPx, viewToPx + margin);
  if (!(toPx > fromPx)) return [];

  const windowStart = fromJulian(startJ + (fromPx / axisPx) * spanJ);
  const windowEnd = fromJulian(startJ + (toPx / axisPx) * spanJ);

  // The step is chosen for the visible window, at the same pixel density as
  // the full axis, so it matches what the eye can actually separate.
  const windowPx = toPx - fromPx;
  const ticks = axisTicks(windowStart, windowEnd, windowPx, targetSpacingPx);

  return ticks.map((t) => ({
    px: fractionalPosition(
      fromJulian(toJulian(windowStart) + t.t * (toJulian(windowEnd) - toJulian(windowStart))),
      start,
      end
    ) * axisPx,
    label: t.label,
  }));
}
