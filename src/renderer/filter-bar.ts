import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import { compare, type TimelineDate } from "../timeline/date";

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

/* ===================================================================== *
 *                          Rich filter panel                            *
 *  Used by inline ```timeline blocks. Collapsed by default. Contains:   *
 *    - category chips                                                   *
 *    - keyword search                                                   *
 *    - label search                                                     *
 *    - date range (precision configurable)                              *
 * ===================================================================== */

export interface RichFilterState {
  hiddenCategories: Set<string>;
  search: string;
  labels: string[];
  start: TimelineDate | null;
  end: TimelineDate | null;
}

export interface RichFilterArgs {
  parent: HTMLElement;
  sourceKey: string;
  allCategories: string[];
  categoryColors: Record<string, string>;
  initialHidden: string[];
  precision: "year" | "day" | "time";
  defaultOpen: boolean;
  onChange: (state: RichFilterState) => void;
}

export interface RichFilterHandle {
  state: RichFilterState;
}

const STORAGE_PREFIX_RICH = "txs:richfilter:";

export function renderRichFilterBar(args: RichFilterArgs): RichFilterHandle {
  const persisted = loadRichState(args.sourceKey);

  const state: RichFilterState = {
    hiddenCategories: new Set<string>([
      ...args.initialHidden,
      ...(persisted?.hiddenCategories ?? []),
    ]),
    search: persisted?.search ?? "",
    labels: persisted?.labels ?? [],
    start: persisted?.start ?? null,
    end: persisted?.end ?? null,
  };

  const panel = args.parent.createEl("details", {
    cls: "txs-filter-rich",
  }) as HTMLDetailsElement;
  panel.open = args.defaultOpen;

  const summary = panel.createEl("summary", { cls: "txs-filter-rich-summary" });
  const badge = summary.createEl("span", { text: "Filters" });

  const updateBadge = () => {
    const n =
      (state.search ? 1 : 0) +
      (state.labels.length ? 1 : 0) +
      (state.start ? 1 : 0) +
      (state.end ? 1 : 0) +
      (state.hiddenCategories.size ? 1 : 0);
    badge.textContent = n ? `Filters (${n} active)` : "Filters";
  };
  updateBadge();

  const fire = () => {
    persistRichState(args.sourceKey, state);
    updateBadge();
    args.onChange(state);
  };

  const body = panel.createDiv({ cls: "txs-filter-rich-body" });

  // Search
  const searchRow = body.createDiv({ cls: "txs-filter-rich-row" });
  searchRow.createEl("label", { text: "Search" });
  const searchInput = searchRow.createEl("input", {
    type: "search",
    placeholder: "title / description / category",
  }) as HTMLInputElement;
  searchInput.value = state.search;
  searchInput.addEventListener("input", () => {
    state.search = searchInput.value;
    fire();
  });

  // Labels
  const labelsRow = body.createDiv({ cls: "txs-filter-rich-row" });
  labelsRow.createEl("label", { text: "Labels (space / comma / ;)" });
  const labelsInput = labelsRow.createEl("input", {
    type: "text",
    placeholder: "label1 label2",
  }) as HTMLInputElement;
  labelsInput.value = state.labels.join(" ");
  labelsInput.addEventListener("input", () => {
    state.labels = labelsInput.value
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    fire();
  });

  // Date range
  const dateRow = body.createDiv({ cls: "txs-filter-rich-row" });
  dateRow.createEl("label", { text: "From → to" });
  const dateBox = dateRow.createDiv({ cls: "txs-filter-rich-dates" });
  const startCtl = inlineDateInputs(dateBox, state.start, args.precision, (d) => {
    state.start = d;
    fire();
  });
  dateBox.createEl("span", { text: "→" });
  const endCtl = inlineDateInputs(dateBox, state.end, args.precision, (d) => {
    state.end = d;
    fire();
  });

  // Categories
  if (args.allCategories.length) {
    const catRow = body.createDiv({ cls: "txs-filter-rich-row" });
    catRow.createEl("label", { text: "Categories" });
    const chipsBox = catRow.createDiv({ cls: "txs-filter-chips" });
    const chipEls = new Map<string, HTMLElement>();
    for (const cat of args.allCategories) {
      const chip = chipsBox.createEl("span", { cls: "txs-filter-chip" });
      const swatch = chip.createEl("span", { cls: "txs-filter-swatch" });
      swatch.style.background = args.categoryColors[cat] ?? "var(--text-muted)";
      chip.createEl("span", { text: cat });
      chip.addEventListener("click", () => {
        if (state.hiddenCategories.has(cat)) state.hiddenCategories.delete(cat);
        else state.hiddenCategories.add(cat);
        paintChip(chip, !state.hiddenCategories.has(cat));
        fire();
      });
      chipEls.set(cat, chip);
      paintChip(chip, !state.hiddenCategories.has(cat));
    }
  }

  // Clear
  const clearRow = body.createDiv({ cls: "txs-filter-rich-row" });
  const clearBtn = clearRow.createEl("button", { text: "Clear filters" });
  clearBtn.addEventListener("click", () => {
    state.hiddenCategories = new Set();
    state.search = "";
    state.labels = [];
    state.start = null;
    state.end = null;
    searchInput.value = "";
    labelsInput.value = "";
    startCtl.reset();
    endCtl.reset();
    // repaint chips
    body.querySelectorAll<HTMLElement>(".txs-filter-chip").forEach((c) => paintChip(c, true));
    fire();
  });

  return { state };
}

/** Apply a RichFilterState to an event list — used by the renderer. */
export function applyRichFilter(
  events: TimelineEvent[],
  state: RichFilterState
): TimelineEvent[] {
  const q = state.search.trim().toLowerCase();
  const labelNeed = state.labels.length
    ? new Set(state.labels.map((s) => s.toLowerCase()))
    : null;
  return events.filter((e) => {
    if (state.hiddenCategories.size && e.category && state.hiddenCategories.has(e.category)) {
      return false;
    }
    if (q) {
      const hay = `${e.text}\n${e.description ?? ""}\n${e.category ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.start && compare(e.end, state.start) < 0) return false;
    if (state.end && compare(e.start, state.end) > 0) return false;
    if (labelNeed) {
      const have = (e.labels ?? []).map((s) => s.toLowerCase());
      if (!have.some((l) => labelNeed.has(l))) return false;
    }
    return true;
  });
}

interface DateCtl {
  reset: () => void;
}

function inlineDateInputs(
  parent: HTMLElement,
  initial: TimelineDate | null,
  precision: "year" | "day" | "time",
  onChange: (d: TimelineDate | null) => void
): DateCtl {
  const wrap = parent.createDiv({ cls: "txs-filter-rich-date-group" });
  const inputs: HTMLInputElement[] = [];
  const mk = (placeholder: string, v: number | undefined, width: number) => {
    const i = wrap.createEl("input", { type: "number", placeholder }) as HTMLInputElement;
    i.style.width = `${width}px`;
    if (v != null) i.value = String(v);
    inputs.push(i);
    return i;
  };
  const yIn = mk("year", initial?.year, 60);
  let moIn: HTMLInputElement | null = null;
  let dIn: HTMLInputElement | null = null;
  let hIn: HTMLInputElement | null = null;
  let miIn: HTMLInputElement | null = null;
  let sIn: HTMLInputElement | null = null;
  if (precision === "day" || precision === "time") {
    moIn = mk("mo", initial?.month, 36);
    dIn = mk("dd", initial?.day, 36);
  }
  if (precision === "time") {
    hIn = mk("hh", initial?.hour, 36);
    miIn = mk("mm", initial?.minute, 36);
    sIn = mk("ss", initial?.second, 36);
  }

  const fire = () => {
    const yv = yIn.value.trim();
    if (yv === "") return onChange(null);
    const year = parseInt(yv, 10);
    if (!Number.isFinite(year)) return onChange(null);
    const intOf = (el: HTMLInputElement | null) => {
      if (!el || el.value.trim() === "") return undefined;
      const n = parseInt(el.value, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    onChange({
      year,
      month: intOf(moIn),
      day: intOf(dIn),
      hour: intOf(hIn),
      minute: intOf(miIn),
      second: intOf(sIn),
    });
  };
  for (const i of inputs) i.addEventListener("input", fire);
  return {
    reset: () => {
      for (const i of inputs) i.value = "";
    },
  };
}

interface PersistShape {
  hiddenCategories: string[];
  search: string;
  labels: string[];
  start: TimelineDate | null;
  end: TimelineDate | null;
}

function loadRichState(sourceKey: string): PersistShape | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX_RICH + sourceKey);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistShape>;
    return {
      hiddenCategories: Array.isArray(p.hiddenCategories) ? p.hiddenCategories : [],
      search: typeof p.search === "string" ? p.search : "",
      labels: Array.isArray(p.labels) ? p.labels : [],
      start: p.start ?? null,
      end: p.end ?? null,
    };
  } catch {
    return null;
  }
}

function persistRichState(sourceKey: string, s: RichFilterState): void {
  try {
    const shape: PersistShape = {
      hiddenCategories: Array.from(s.hiddenCategories),
      search: s.search,
      labels: s.labels,
      start: s.start,
      end: s.end,
    };
    localStorage.setItem(STORAGE_PREFIX_RICH + sourceKey, JSON.stringify(shape));
  } catch {
    /* ignore */
  }
}
