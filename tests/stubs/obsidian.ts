/**
 * Stand-in for the `obsidian` module, which ships types only — importing it
 * from vitest fails because the package has no runtime entry point. Only the
 * runtime values the plugin actually touches need to exist here; every
 * `import type` is erased at compile time.
 */

export class TFile {
  path = "";
  extension = "md";
  stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder {
  path = "";
  children: unknown[] = [];
}

export class Notice {
  constructor(public message: string, public timeout?: number) {}
}

export class Modal {
  contentEl = document.createElement("div");
  titleEl = document.createElement("div");
  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(public containerEl: HTMLElement) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
}

export class PluginSettingTab {}
export class ItemView {}
export class MarkdownRenderer {}

export const Platform = { isMobile: false, isIosApp: false, isDesktop: true };

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
