/**
 * Minimal polyfill for the Obsidian-specific DOM helpers (createDiv,
 * createEl, createSpan, empty, addClass, removeClass, hasClass, toggleClass,
 * setAttr, setCssProps, appendText)
 * that the renderer uses but jsdom does not provide. Lets us exercise
 * renderTimeline end-to-end from vitest without launching Obsidian.
 */

type CreateOpts = {
  text?: string;
  cls?: string;
  href?: string;
  attr?: Record<string, string>;
};

const proto = (typeof HTMLElement !== "undefined" ? HTMLElement.prototype : null) as any;
const elProto = (typeof Element !== "undefined" ? Element.prototype : null) as any;

if (proto) {
  if (!proto.empty) {
    proto.empty = function (): void {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
  }
  if (!proto.createEl) {
    proto.createEl = function (tag: string, opts?: CreateOpts): HTMLElement {
      const el = document.createElement(tag);
      if (opts?.text != null) el.textContent = opts.text;
      if (opts?.cls) el.className = opts.cls;
      if (opts?.href) el.setAttribute("href", opts.href);
      if (opts?.attr) {
        for (const k of Object.keys(opts.attr)) el.setAttribute(k, opts.attr[k]);
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (opts?: CreateOpts): HTMLElement {
      return this.createEl("div", opts);
    };
  }
  if (!proto.createSpan) {
    proto.createSpan = function (opts?: CreateOpts): HTMLElement {
      return this.createEl("span", opts);
    };
  }
  if (!proto.addClass) {
    proto.addClass = function (cls: string): void {
      this.classList.add(cls);
    };
  }
  if (!proto.toggleClass) {
    proto.toggleClass = function (cls: string, on: boolean): void {
      this.classList.toggle(cls, on);
    };
  }
  if (!proto.setAttr) {
    proto.setAttr = function (k: string, v: string | number | boolean): void {
      this.setAttribute(k, String(v));
    };
  }
  if (!proto.appendText) {
    proto.appendText = function (t: string): void {
      this.appendChild(document.createTextNode(t));
    };
  }
  if (!proto.removeClass) {
    proto.removeClass = function (cls: string): void {
      this.classList.remove(cls);
    };
  }
  if (!proto.hasClass) {
    proto.hasClass = function (cls: string): boolean {
      return this.classList.contains(cls);
    };
  }
  if (!proto.createSvg) {
    proto.createSvg = function (tag: string, opts?: CreateOpts): SVGElement {
      const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
      if (opts?.cls) el.setAttribute("class", opts.cls);
      if (opts?.text) el.textContent = opts.text;
      if (opts?.attr) {
        for (const k of Object.keys(opts.attr)) el.setAttribute(k, opts.attr[k]);
      }
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.setCssProps) {
    proto.setCssProps = function (props: Record<string, string>): void {
      for (const [k, v] of Object.entries(props)) {
        this.style.setProperty(k, v);
      }
    };
  }
}

if (elProto && !elProto.empty) {
  // SVG elements live under Element, not HTMLElement. Mirror the helpers.
  elProto.empty = function (): void {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  elProto.addClass = function (cls: string): void {
    this.classList.add(cls);
  };
  elProto.toggleClass = function (cls: string, on: boolean): void {
    this.classList.toggle(cls, on);
  };
  elProto.setAttr = function (k: string, v: string | number | boolean): void {
    this.setAttribute(k, String(v));
  };
}

// Obsidian also exposes createEl / createDiv / createSpan as globals that
// return a detached element. `text-metrics` uses the global form to build the
// canvas it measures label widths with.
const globalScope = globalThis as unknown as Record<string, unknown>;
if (typeof document !== "undefined" && !globalScope.createEl) {
  globalScope.createEl = (tag: string, opts?: CreateOpts): HTMLElement => {
    // jsdom has no canvas, and asking one for a 2D context logs a "not
    // implemented" warning on every render. Hand back something without a
    // getContext instead: `text-metrics` treats that as "cannot measure" and
    // falls back to its character estimate, which is what jsdom can support.
    const el = document.createElement(tag === "canvas" ? "div" : tag);
    if (opts?.text != null) el.textContent = opts.text;
    if (opts?.cls) el.className = opts.cls;
    return el;
  };
}
