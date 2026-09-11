/**
 * Label widths, measured rather than guessed.
 *
 * Callouts are packed into the gaps between bars, so a width estimate that is
 * 15% low prints a name over the bar next to it. Counting characters cannot do
 * better than that: "D-Day" runs 7.2px per character at 12px where "Paris
 * liberated" runs 5.4px.
 *
 * A canvas 2D context measures text without touching the document, so unlike
 * `getComputedTextLength` this costs no layout and is safe inside a scroll
 * frame. Results are cached per font and string; where there is no canvas
 * (jsdom) the old character estimate stands in.
 */

export type Measure = (text: string) => number;

/** The figure the renderer used before anything was measured. */
export const FALLBACK_CHAR_WIDTH = 6.5;

const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    // Detached: it is never inserted, it only measures.
    ctx = createEl("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * A measurer for one font. `fontSpec` is a CSS `font` shorthand, for example
 * `400 12px Inter, sans-serif`.
 */
export function measurerFor(fontSpec: string): Measure {
  const c = context();
  if (!c) return (text) => text.length * FALLBACK_CHAR_WIDTH;
  return (text) => {
    const key = `${fontSpec} ${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    c.font = fontSpec;
    const width = c.measureText(text).width;
    cache.set(key, width);
    return width;
  };
}

/**
 * The font a label will actually be drawn in: size and weight come from
 * `styles.css`, the family from whatever theme the vault is wearing.
 */
export function labelFontSpec(el: Element, sizePx = 12, weight = 400): string {
  let family = "sans-serif";
  try {
    const computed = window.getComputedStyle(el).fontFamily;
    if (computed) family = computed;
  } catch {
    // No layout engine: the fallback measurer ignores this anyway.
  }
  return `${weight} ${sizePx}px ${family}`;
}
