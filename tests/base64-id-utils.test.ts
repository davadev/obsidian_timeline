import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, base64ToArrayBuffer, guessImageExtension } from "../src/timeline/base64";
import { slugify, uniqueSlug } from "../src/timeline/id-utils";

describe("base64", () => {
  it("round-trips bytes, including a payload larger than one chunk", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251);
    const back = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)));
    expect(back).toEqual(bytes);
  });

  it("ignores whitespace inside the base64 text", () => {
    const b64 = arrayBufferToBase64(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    const spaced = `${b64.slice(0, 2)}\n ${b64.slice(2)}`;
    expect([...new Uint8Array(base64ToArrayBuffer(spaced))]).toEqual([1, 2, 3, 4, 5]);
  });

  it("guesses the image type from the magic bytes", () => {
    expect(guessImageExtension("iVBORw0KGgo=")).toBe("png");
    expect(guessImageExtension("/9j/4AAQ")).toBe("jpg");
    expect(guessImageExtension("R0lGODlh")).toBe("gif");
    expect(guessImageExtension("UklGRg==")).toBe("webp");
    expect(guessImageExtension("PHN2ZyB4")).toBe("svg");
    expect(guessImageExtension("AAAA")).toBe("png");
  });
});

describe("slugify", () => {
  it("lowercases, strips diacritics and collapses punctuation", () => {
    expect(slugify("Café  Müller, 1914!")).toBe("cafe-muller-1914");
  });
  it("falls back to 'event' for empty or symbol-only input", () => {
    expect(slugify("")).toBe("event");
    expect(slugify("!!!")).toBe("event");
  });
  it("truncates to maxLen", () => {
    expect(slugify("abcdefghij", 4)).toBe("abcd");
    expect(slugify("a".repeat(200)).length).toBe(80);
  });
});

describe("uniqueSlug", () => {
  it("returns the base when free and numbers collisions from 2", () => {
    const used = new Set<string>();
    expect(uniqueSlug("rome", used)).toBe("rome");
    expect(uniqueSlug("rome", used)).toBe("rome-2");
    expect(uniqueSlug("rome", used)).toBe("rome-3");
    expect(used).toEqual(new Set(["rome", "rome-2", "rome-3"]));
  });
});
