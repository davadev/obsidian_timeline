import type { TimelineCategory, TimelineEvent } from "../timeline/model";

/**
 * Renders a category chip bar above the timeline. Each chip toggles a
 * category's visibility for this render only. State is persisted to
 * localStorage keyed by `sourceKey` so the user's filter survives navigation.
 *
 * The bar is intentionally compact and uses native DOM only — no Obsidian
 * Modal — so it works identically on desktop and mobile.
 */

const STORAGE_PREFIX = "txs:filter:hidden:";

export interface FilterBarArgs {
  parent: HTMLElement;
  /** Stable key for persistence — usually `source` from the render block. */
  sourceKey: string;
  /** All category names available in the current render. */
  allCategories: string[];
  /** Initial hidden set (computed by the postprocessor from block/global settings). */
  initialHidden: string[];
  /** Map category → color for the swatch. */
  categoryColors: Record<string, string>;
  /** Called with the new hidden set whenever the user toggles a chip. */
  onChange: (hidden: Set<string>) => void;
}

export function renderFilterBar(args: FilterBarArgs): HTMLElement {
  const persisted = loadHidden(args.sourceKey);
  // Merge initial + persisted (persisted wins for chips the user already touched).
  const hidden = new Set<string>([...args.initialHidden, ...persisted]);

  const bar = args.parent.createDiv({ cls: "txs-filter-bar" });

  // "All / None" toggle.
  const allBtn = bar.createEl("button", {
    cls: "txs-filter-action",
    text: "All",
  });
  allBtn.addEventListener("click", () => {
    hidden.clear();
    persistHidden(args.sourceKey, hidden);
    refresh();
    args.onChange(new Set(hidden));
  });
  const noneBtn = bar.createEl("button", {
    cls: "txs-filter-action",
    text: "None",
  });
  noneBtn.addEventListener("click", () => {
    for (const c of args.allCategories) hidden.add(c);
    persistHidden(args.sourceKey, hidden);
    refresh();
    args.onChange(new Set(hidden));
  });

  const chipsBox = bar.createDiv({ cls: "txs-filter-chips" });
  const chipEls = new Map<string, HTMLElement>();

  for (const cat of args.allCategories) {
    const chip = chipsBox.createEl("span", { cls: "txs-filter-chip" });
    const swatch = chip.createEl("span", { cls: "txs-filter-swatch" });
    swatch.style.background =
      args.categoryColors[cat] ?? "var(--text-muted)";
    chip.createEl("span", { text: cat });
    chip.addEventListener("click", () => {
      if (hidden.has(cat)) hidden.delete(cat);
      else hidden.add(cat);
      persistHidden(args.sourceKey, hidden);
      paintChip(chip, !hidden.has(cat));
      args.onChange(new Set(hidden));
    });
    chipEls.set(cat, chip);
    paintChip(chip, !hidden.has(cat));
  }

  function refresh(): void {
    for (const [cat, el] of chipEls) paintChip(el, !hidden.has(cat));
  }

  return bar;
}

function paintChip(el: HTMLElement, active: boolean): void {
  el.classList.toggle("is-active", active);
  el.classList.toggle("is-inactive", !active);
}

export function loadHidden(sourceKey: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sourceKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function persistHidden(sourceKey: string, hidden: Set<string>): void {
  try {
    localStorage.setItem(
      STORAGE_PREFIX + sourceKey,
      JSON.stringify(Array.from(hidden))
    );
  } catch {
    /* ignore */
  }
}

/** Helper for the postprocessor — collect distinct categories from events. */
export function distinctCategories(
  events: TimelineEvent[],
  catalog: TimelineCategory[]
): string[] {
  const set = new Set<string>();
  for (const e of events) if (e.category) set.add(e.category);
  for (const c of catalog) if (c.name) set.add(c.name);
  return Array.from(set).sort();
}
