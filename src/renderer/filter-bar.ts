import type { TimelineCategory, TimelineEvent } from "../timeline/model";
import { compare, type TimelineDate } from "../timeline/date";
import { readDevice, writeDevice } from "../obsidian/app-storage";

/**
 * Renders a category chip bar above the timeline. Each chip toggles a
 * category's visibility for this render only. State is persisted to
 * device-local storage keyed by `sourceKey` so the user's filter survives
 * navigation (and never syncs to other devices).
 *
 * The bar is intentionally compact and uses native DOM only — no Obsidian
 * Modal — so it works identically on desktop and mobile.
 */

const STORAGE_PREFIX = "filter:hidden:";
/** Raw localStorage prefix used before 0.9.4; migrated on first read. */
const LEGACY_STORAGE_PREFIX = "txs:filter:hidden:";

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
    const chip = chipsBox.createSpan({ cls: "txs-filter-chip" });
    const swatch = chip.createSpan({ cls: "txs-filter-swatch" });
    swatch.style.background =
      args.categoryColors[cat] ?? "var(--text-muted)";
    chip.createSpan({ text: cat });
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
  const parsed = readDevice<unknown>(
    STORAGE_PREFIX + sourceKey,
    LEGACY_STORAGE_PREFIX + sourceKey
  );
  return Array.isArray(parsed)
    ? (parsed as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
}

function persistHidden(sourceKey: string, hidden: Set<string>): void {
  writeDevice(STORAGE_PREFIX + sourceKey, Array.from(hidden));
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
  /** Zoom override — null means "fall back to block's zoom / global default". */
  zoom: number | null;
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

const STORAGE_PREFIX_RICH = "richfilter:";
/** Raw localStorage prefix used before 0.9.4; migrated on first read. */
const LEGACY_STORAGE_PREFIX_RICH = "txs:richfilter:";

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
    zoom: persisted?.zoom ?? null,
  };

  const panel = args.parent.createEl("details", {
    cls: "txs-filter-rich",
  });
  panel.open = args.defaultOpen;

  const summary = panel.createEl("summary", { cls: "txs-filter-rich-summary" });
  const badge = summary.createSpan({ text: "Filters" });

  const updateBadge = () => {
    const n =
      (state.search ? 1 : 0) +
      (state.labels.length ? 1 : 0) +
      (state.start ? 1 : 0) +
      (state.end ? 1 : 0) +
      (state.hiddenCategories.size ? 1 : 0) +
      (state.zoom != null ? 1 : 0);
    badge.textContent = n ? `Filters (${n} active)` : "Filters";
  };
  updateBadge();

  // Coalesce keystrokes — without this every character in a search box
  // re-renders the timeline AND rewrites the block YAML, which makes typing
  // jarring (the body redraws under the input on every key). Keep the badge
  // updates instant for responsiveness; defer the heavy work to a debounce.
  let fireTimer: number | null = null;
  const fire = () => {
    updateBadge();
    if (fireTimer) window.clearTimeout(fireTimer);
    fireTimer = window.setTimeout(() => {
      fireTimer = null;
      persistRichState(args.sourceKey, state);
      args.onChange(state);
    }, 250);
  };

  const body = panel.createDiv({ cls: "txs-filter-rich-body" });

  // Search
  const searchRow = body.createDiv({ cls: "txs-filter-rich-row" });
  searchRow.createEl("label", { text: "Search" });
  const searchInput = searchRow.createEl("input", {
    type: "search",
    placeholder: "title / description / category",
  });
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
  });
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
  dateBox.createSpan({ text: "→" });
  const endCtl = inlineDateInputs(dateBox, state.end, args.precision, (d) => {
    state.end = d;
    fire();
  });

  // Zoom override
  const zoomRow = body.createDiv({ cls: "txs-filter-rich-row" });
  zoomRow.createEl("label", { text: "Zoom override (blank = default)" });
  const zoomInput = zoomRow.createEl("input", {
    type: "number",
    placeholder: "e.g. 3",
  });
  zoomInput.addClass("txs-filter-zoom-input");
  zoomInput.step = "0.5";
  zoomInput.min = "0.5";
  if (state.zoom != null) zoomInput.value = String(state.zoom);
  zoomInput.addEventListener("input", () => {
    const v = zoomInput.value.trim();
    if (v === "") {
      state.zoom = null;
    } else {
      const n = parseFloat(v);
      state.zoom = Number.isFinite(n) && n > 0 ? n : null;
    }
    fire();
  });

  // Categories
  if (args.allCategories.length) {
    const catRow = body.createDiv({ cls: "txs-filter-rich-row" });
    catRow.createEl("label", { text: "Categories" });
    const chipsBox = catRow.createDiv({ cls: "txs-filter-chips" });
    const chipEls = new Map<string, HTMLElement>();
    for (const cat of args.allCategories) {
      const chip = chipsBox.createSpan({ cls: "txs-filter-chip" });
      const swatch = chip.createSpan({ cls: "txs-filter-swatch" });
      swatch.style.background = args.categoryColors[cat] ?? "var(--text-muted)";
      chip.createSpan({ text: cat });
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
    state.zoom = null;
    searchInput.value = "";
    labelsInput.value = "";
    zoomInput.value = "";
    startCtl.reset();
    endCtl.reset();
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
  // Pre-normalise the filter boundaries:
  //  - start fills missing components with the START of the period (1 / 1 / 0)
  //    → "year -2400" means "from Jan 1 of -2400 onwards"
  //  - end fills missing components with the END of the period (12 / 31 / 23 …)
  //    → "year -2000" means "through Dec 31 of -2000"
  // Without this an event with start = {-2000, 6, 15} got dropped against an
  // end = {-2000} because compare() defaulted both to Jan 1 and the event
  // start ended up "after" the filter end.
  const filterStart = state.start ?? null;
  const filterEnd = state.end ? expandToEndOfPeriod(state.end) : null;
  return events.filter((e) => {
    if (state.hiddenCategories.size && e.category && state.hiddenCategories.has(e.category)) {
      return false;
    }
    if (q) {
      const hay = `${e.text}\n${e.description ?? ""}\n${e.category ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filterStart && compare(e.end, filterStart) < 0) return false;
    if (filterEnd && compare(e.start, filterEnd) > 0) return false;
    if (labelNeed) {
      const have = (e.labels ?? []).map((s) => s.toLowerCase());
      if (!have.some((l) => labelNeed.has(l))) return false;
    }
    return true;
  });
}

/**
 * Expand a partial TimelineDate to the LAST instant of the largest specified
 * unit, so a year-only or year+month-only filter end is treated inclusively.
 */
function expandToEndOfPeriod(d: TimelineDate): TimelineDate {
  const out: TimelineDate = { ...d };
  if (out.month == null) {
    out.month = 12;
    out.day = 31;
    out.hour = 23;
    out.minute = 59;
    out.second = 59;
    return out;
  }
  if (out.day == null) {
    out.day = daysInMonth(out.year, out.month);
    out.hour = 23;
    out.minute = 59;
    out.second = 59;
    return out;
  }
  if (out.hour == null) {
    out.hour = 23;
    out.minute = 59;
    out.second = 59;
    return out;
  }
  if (out.minute == null) {
    out.minute = 59;
    out.second = 59;
    return out;
  }
  if (out.second == null) {
    out.second = 59;
  }
  return out;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap =
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
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
    const i = wrap.createEl("input", { type: "number", placeholder });
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
  zoom: number | null;
}

function loadRichState(sourceKey: string): PersistShape | null {
  const p = readDevice<Partial<PersistShape>>(
    STORAGE_PREFIX_RICH + sourceKey,
    LEGACY_STORAGE_PREFIX_RICH + sourceKey
  );
  if (!p || typeof p !== "object") return null;
  return {
    hiddenCategories: Array.isArray(p.hiddenCategories) ? p.hiddenCategories : [],
    search: typeof p.search === "string" ? p.search : "",
    labels: Array.isArray(p.labels) ? p.labels : [],
    start: p.start ?? null,
    end: p.end ?? null,
    zoom: typeof p.zoom === "number" && p.zoom > 0 ? p.zoom : null,
  };
}

function persistRichState(sourceKey: string, s: RichFilterState): void {
  const shape: PersistShape = {
    hiddenCategories: Array.from(s.hiddenCategories),
    search: s.search,
    labels: s.labels,
    start: s.start,
    end: s.end,
    zoom: s.zoom,
  };
  writeDevice(STORAGE_PREFIX_RICH + sourceKey, shape);
}
