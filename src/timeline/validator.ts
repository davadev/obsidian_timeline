import { compare, type TimelineDate } from "./date";
import type { EventNote } from "./model";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const MONTHS_31 = new Set([1, 3, 5, 7, 8, 10, 12]);

function isLeap(year: number): boolean {
  // Proleptic Gregorian
  if (year % 4 !== 0) return false;
  if (year % 100 !== 0) return true;
  return year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return MONTHS_31.has(month) ? 31 : 30;
}

function validateDate(
  d: TimelineDate,
  field: string,
  path: string,
  errors: ValidationError[]
): void {
  if (!Number.isInteger(d.year)) {
    errors.push({ path, message: `${field}.year must be an integer` });
  }
  if (d.month != null && (d.month < 1 || d.month > 12)) {
    errors.push({ path, message: `${field}.month must be 1..12` });
  }
  if (d.day != null && d.month != null) {
    const max = daysInMonth(d.year, d.month);
    if (d.day < 1 || d.day > max) {
      errors.push({
        path,
        message: `${field}.day ${d.day} invalid for ${d.year}-${d.month} (max ${max})`,
      });
    }
  }
  if (d.hour != null && (d.hour < 0 || d.hour > 23)) {
    errors.push({ path, message: `${field}.hour must be 0..23` });
  }
  if (d.minute != null && (d.minute < 0 || d.minute > 59)) {
    errors.push({ path, message: `${field}.minute must be 0..59` });
  }
  if (d.second != null && (d.second < 0 || d.second > 59)) {
    errors.push({ path, message: `${field}.second must be 0..59` });
  }
}

export function validateEventNote(note: EventNote): ValidationResult {
  const errors: ValidationError[] = [];
  const path = note.location.path;
  const ev = note.event;

  if (!ev.id) errors.push({ path, message: "Missing timeline.event_id" });
  if (!ev.text) errors.push({ path, message: "Missing title/text" });

  validateDate(ev.start, "timeline.start", path, errors);
  validateDate(ev.end, "timeline.end", path, errors);

  if (compare(ev.start, ev.end) > 0) {
    errors.push({
      path,
      message: "timeline.start must be <= timeline.end",
    });
  }

  return { ok: errors.length === 0, errors };
}

export function validateAll(notes: EventNote[]): ValidationResult {
  const errors: ValidationError[] = [];
  const seenIds = new Map<string, string>();
  for (const note of notes) {
    const r = validateEventNote(note);
    errors.push(...r.errors);
    const id = note.event.id;
    if (id) {
      const prev = seenIds.get(id);
      if (prev) {
        errors.push({
          path: note.location.path,
          message: `Duplicate timeline.event_id "${id}" (also in ${prev})`,
        });
      } else {
        seenIds.set(id, note.location.path);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
