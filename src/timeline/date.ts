/**
 * TimelineDate — calendar date that supports BCE (negative years) deterministically,
 * without depending on the JavaScript Date object (which fails for years < 100 and
 * cannot represent BCE cleanly).
 *
 * Only year is required. Lower components default to 1 (month/day) or 0 (time) for
 * comparison purposes but are preserved as undefined when the source omitted them.
 */

export interface TimelineDate {
  year: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
}

export interface CompleteTimelineDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const PAD2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const PAD4 = (n: number) => {
  const abs = Math.abs(n).toString().padStart(4, "0");
  return n < 0 ? `-${abs}` : abs;
};

export function complete(d: TimelineDate): CompleteTimelineDate {
  return {
    year: d.year,
    month: d.month ?? 1,
    day: d.day ?? 1,
    hour: d.hour ?? 0,
    minute: d.minute ?? 0,
    second: d.second ?? 0,
  };
}

/**
 * Total ordering for TimelineDate. Returns negative if a<b, positive if a>b, 0 if equal.
 * Safe for any integer year including negatives.
 */
export function compare(a: TimelineDate, b: TimelineDate): number {
  const A = complete(a);
  const B = complete(b);
  if (A.year !== B.year) return A.year - B.year;
  if (A.month !== B.month) return A.month - B.month;
  if (A.day !== B.day) return A.day - B.day;
  if (A.hour !== B.hour) return A.hour - B.hour;
  if (A.minute !== B.minute) return A.minute - B.minute;
  return A.second - B.second;
}

export function equals(a: TimelineDate, b: TimelineDate): boolean {
  return compare(a, b) === 0;
}

/** ISO-like canonical string: ±YYYY-MM-DD HH:MM:SS (used in XML round-trip). */
export function toXmlString(d: TimelineDate): string {
  const c = complete(d);
  return `${PAD4(c.year)}-${PAD2(c.month)}-${PAD2(c.day)} ${PAD2(c.hour)}:${PAD2(c.minute)}:${PAD2(c.second)}`;
}

/** Frontmatter-friendly string: ±YYYY-MM-DD (date only). */
export function toFrontmatterString(d: TimelineDate): string {
  const c = complete(d);
  return `${PAD4(c.year)}-${PAD2(c.month)}-${PAD2(c.day)}`;
}

/**
 * Parse a Timeline Project XML date string.
 * Accepts: "YYYY-MM-DD HH:MM:SS", "-YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD",
 * "YYYY-MM-DDTHH:MM:SS", with arbitrary year width.
 * Returns null on failure (caller decides whether to throw).
 */
export function parseXmlDate(raw: string): TimelineDate | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // Detect leading sign
  let sign = 1;
  let body = s;
  if (body.startsWith("-")) {
    sign = -1;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }

  const match = body.match(
    /^(\d{1,9})(?:-(\d{1,2})(?:-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?)?)?$/
  );
  if (!match) return null;

  const [, yStr, moStr, dStr, hStr, miStr, sStr] = match;
  const year = sign * parseInt(yStr, 10);
  return {
    year,
    month: moStr != null ? parseInt(moStr, 10) : undefined,
    day: dStr != null ? parseInt(dStr, 10) : undefined,
    hour: hStr != null ? parseInt(hStr, 10) : undefined,
    minute: miStr != null ? parseInt(miStr, 10) : undefined,
    second: sStr != null ? parseInt(sStr, 10) : undefined,
  };
}

/** Parse a frontmatter date string. Same grammar as XML but typically date-only. */
export function parseFrontmatterDate(raw: unknown): TimelineDate | null {
  if (typeof raw === "number") return { year: raw };
  if (typeof raw !== "string") return null;
  return parseXmlDate(raw);
}

/** Whether `range` and `viewport` overlap. Both are inclusive ranges. */
export function rangesOverlap(
  aStart: TimelineDate,
  aEnd: TimelineDate,
  bStart: TimelineDate,
  bEnd: TimelineDate
): boolean {
  return compare(aStart, bEnd) <= 0 && compare(aEnd, bStart) >= 0;
}

/** Whether a point date sits inside the inclusive viewport range. */
export function pointInRange(
  p: TimelineDate,
  start: TimelineDate,
  end: TimelineDate
): boolean {
  return compare(p, start) >= 0 && compare(p, end) <= 0;
}

/**
 * Compute fractional position of `date` within [start, end], using Julian Day Number
 * for stable, calendar-aware proportional placement (so BCE/CE math is monotone).
 * Returns a value in [0, 1] when clamped is true; otherwise may exceed bounds.
 */
export function fractionalPosition(
  date: TimelineDate,
  start: TimelineDate,
  end: TimelineDate,
  clamped = true
): number {
  const d = toJulian(date);
  const s = toJulian(start);
  const e = toJulian(end);
  if (e === s) return 0;
  const raw = (d - s) / (e - s);
  if (!clamped) return raw;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Julian Day Number using the proleptic Gregorian calendar so the algebra is
 * monotone across BCE/CE. Sub-day components contribute a fractional part.
 * This is for proportional layout only — never used for semantic comparison.
 */
/**
 * Inverse of {@link toJulian}: a Julian Day Number back to a proleptic
 * Gregorian date. Used to turn a position along the axis into the date it
 * represents, so the axis can label only the stretch currently on screen.
 */
export function fromJulian(j: number): TimelineDate {
  const jdn = Math.floor(j + 0.5);
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d2 = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d2) / 4);
  const m = Math.floor((5 * e + 2) / 153);

  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d2 - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

export function toJulian(d: TimelineDate): number {
  const c = complete(d);
  const a = Math.floor((14 - c.month) / 12);
  const y = c.year + 4800 - a;
  const m = c.month + 12 * a - 3;
  const jdn =
    c.day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;
  const frac =
    (c.hour - 12) / 24 + c.minute / 1440 + c.second / 86400;
  return jdn + frac;
}
