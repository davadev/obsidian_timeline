import { describe, it, expect } from "vitest";
import { validateAll, validateEventNote } from "../src/timeline/validator";
import type { EventNote, TimelineEvent } from "../src/timeline/model";

function note(ev: TimelineEvent, path = "events/e.md"): EventNote {
  return { event: ev, location: { path }, extraFrontmatter: {}, body: "", mirrors: {} };
}

describe("validator", () => {
  it("flags missing id, missing text, and invalid dates", () => {
    const r = validateEventNote(
      note({
        id: "",
        text: "",
        start: { year: 2024, month: 13, day: 50 },
        end: { year: 2024, month: 1, day: 1 },
        isPoint: false,
      })
    );
    expect(r.ok).toBe(false);
    const msgs = r.errors.map((e) => e.message);
    expect(msgs).toEqual(expect.arrayContaining([
      "Missing timeline.event_id",
      "Missing title/text",
      "timeline.start.month must be 1..12",
      "timeline.start must be <= timeline.end",
    ]));
  });

  it("flags duplicate event ids across notes", () => {
    const a = note({
      id: "dup",
      text: "A",
      start: { year: 2000 },
      end: { year: 2001 },
      isPoint: false,
    }, "events/a.md");
    const b = note({
      id: "dup",
      text: "B",
      start: { year: 2000 },
      end: { year: 2001 },
      isPoint: false,
    }, "events/b.md");
    const r = validateAll([a, b]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });

  it("passes valid BCE event", () => {
    const r = validateEventNote(
      note({
        id: "x",
        text: "x",
        start: { year: -400, month: 2, day: 29 }, // -400 is proleptic leap
        end: { year: -100, month: 2, day: 28 },
        isPoint: false,
      })
    );
    expect(r.ok).toBe(true);
  });

  it("rejects Feb 29 in a non-leap BCE year", () => {
    const r = validateEventNote(
      note({
        id: "x",
        text: "x",
        start: { year: -200, month: 2, day: 29 },
        end: { year: -100, month: 2, day: 28 },
        isPoint: false,
      })
    );
    expect(r.ok).toBe(false);
  });
});
