/**
 * Stand-in for the `obsidian` module, which ships types only — importing it
 * from vitest fails because the package has no runtime entry point.
 *
 * It is one shared stub that *records* what the plugin asks of the host, so a
 * test loads the plugin and asserts on what it registered (commands, views,
 * events, notices, modals) instead of mocking `obsidian` per file. DOM-backed
 * pieces (modals, views, settings) need `./setup-obsidian-dom` imported by the
 * test, as the real ones live in a browser.
 */

export abstract class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension = "md";
  basename = "";
  stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  static instances: Notice[] = [];
  static reset(): void {
    Notice.instances = [];
  }
  static messages(): string[] {
    return Notice.instances.map((n) => n.message);
  }
  hidden = false;
  constructor(
    public message: string,
    public timeout?: number,
  ) {
    Notice.instances.push(this);
  }
  setMessage(message: string): this {
    this.message = message;
    return this;
  }
  hide(): void {
    this.hidden = true;
  }
}

export class Modal {
  static instances: Modal[] = [];
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  opened = false;
  constructor(public app: unknown) {
    this.contentEl = document.createElement("div");
    this.titleEl = document.createElement("div");
    withSetText(this.titleEl);
    Modal.instances.push(this);
  }
  open(): void {
    this.opened = true;
    this.onOpen();
  }
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  inputEl = document.createElement("input");
  placeholder = "";
  setPlaceholder(p: string): void {
    this.placeholder = p;
  }
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_item: T, _el: HTMLElement): void {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

function withSetText(el: HTMLElement): void {
  (el as HTMLElement & { setText: (t: string) => void }).setText = (t: string) => {
    el.textContent = t;
  };
}

/** Components returned by Setting.addX(), enough to drive onChange handlers. */
export class TextComponent {
  inputEl = document.createElement("input");
  private handler: ((v: string) => unknown) | null = null;
  constructor() {
    this.inputEl.type = "text";
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  setValue(v: string): this {
    this.inputEl.value = v;
    return this;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  onChange(fn: (v: string) => unknown): this {
    this.handler = fn;
    return this;
  }
  /** Test helper: simulate the user typing. */
  async type(v: string): Promise<void> {
    this.inputEl.value = v;
    await this.handler?.(v);
  }
}

export class ToggleComponent {
  value = false;
  private handler: ((v: boolean) => unknown) | null = null;
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  onChange(fn: (v: boolean) => unknown): this {
    this.handler = fn;
    return this;
  }
  async toggle(v: boolean): Promise<void> {
    this.value = v;
    await this.handler?.(v);
  }
}

export class DropdownComponent {
  options: Record<string, string> = {};
  value = "";
  private handler: ((v: string) => unknown) | null = null;
  addOption(value: string, label: string): this {
    this.options[value] = label;
    return this;
  }
  addOptions(o: Record<string, string>): this {
    Object.assign(this.options, o);
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  onChange(fn: (v: string) => unknown): this {
    this.handler = fn;
    return this;
  }
  async select(v: string): Promise<void> {
    this.value = v;
    await this.handler?.(v);
  }
}

export class ButtonComponent {
  buttonEl = document.createElement("button");
  private handler: (() => unknown) | null = null;
  setButtonText(t: string): this {
    this.buttonEl.textContent = t;
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setDisabled(d: boolean): this {
    this.buttonEl.disabled = d;
    return this;
  }
  onClick(fn: () => unknown): this {
    this.handler = fn;
    return this;
  }
  async click(): Promise<void> {
    await this.handler?.();
  }
}

export class SliderComponent {
  value = 0;
  private handler: ((v: number) => unknown) | null = null;
  setLimits(): this {
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  setValue(v: number): this {
    this.value = v;
    return this;
  }
  onChange(fn: (v: number) => unknown): this {
    this.handler = fn;
    return this;
  }
  async slide(v: number): Promise<void> {
    this.value = v;
    await this.handler?.(v);
  }
}

export class Setting {
  static instances: Setting[] = [];
  name = "";
  desc = "";
  heading = false;
  text: TextComponent[] = [];
  textAreas: TextComponent[] = [];
  toggles: ToggleComponent[] = [];
  dropdowns: DropdownComponent[] = [];
  buttons: ButtonComponent[] = [];
  sliders: SliderComponent[] = [];
  settingEl = document.createElement("div");
  constructor(public containerEl: HTMLElement) {
    containerEl.appendChild(this.settingEl);
    Setting.instances.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  setClass(): this {
    return this;
  }
  addText(cb: (t: TextComponent) => unknown): this {
    const c = new TextComponent();
    this.text.push(c);
    cb(c);
    return this;
  }
  addTextArea(cb: (t: TextComponent) => unknown): this {
    const c = new TextComponent();
    this.textAreas.push(c);
    cb(c);
    return this;
  }
  addToggle(cb: (t: ToggleComponent) => unknown): this {
    const c = new ToggleComponent();
    this.toggles.push(c);
    cb(c);
    return this;
  }
  addDropdown(cb: (d: DropdownComponent) => unknown): this {
    const c = new DropdownComponent();
    this.dropdowns.push(c);
    cb(c);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => unknown): this {
    const c = new ButtonComponent();
    this.buttons.push(c);
    cb(c);
    return this;
  }
  addSlider(cb: (s: SliderComponent) => unknown): this {
    const c = new SliderComponent();
    this.sliders.push(c);
    cb(c);
    return this;
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
  display(): void {}
  hide(): void {}
}

export class Component {
  children: Component[] = [];
  addChild<T extends Component>(c: T): T {
    this.children.push(c);
    return c;
  }
  register(_cb?: () => void): void {}
  registerEvent(_ref?: unknown): void {}
  onload(): void {}
  onunload(): void {}
}

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

export class MarkdownRenderer {
  static calls: Array<{ markdown: string; el: HTMLElement; path: string }> = [];
  static fail = false;
  static async render(_app: unknown, markdown: string, el: HTMLElement, path: string): Promise<void> {
    if (MarkdownRenderer.fail) throw new Error("render failed");
    MarkdownRenderer.calls.push({ markdown, el, path });
    el.textContent = markdown;
  }
}

export class WorkspaceLeaf {
  view: unknown = null;
  viewState: { type?: string; active?: boolean } | null = null;
  async setViewState(s: { type: string; active?: boolean }): Promise<void> {
    this.viewState = s;
  }
  detach(): void {}
}

export class ItemView extends Component {
  containerEl = document.createElement("div");
  contentEl: HTMLElement;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.containerEl.appendChild(document.createElement("div"));
    this.contentEl = this.containerEl.appendChild(document.createElement("div"));
  }
  get app(): unknown {
    return (this.leaf as unknown as { app?: unknown }).app;
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class MarkdownView extends ItemView {
  file: TFile | null = null;
}

/** Records everything the plugin registers with the host. */
export class Plugin extends Component {
  commands: Array<{ id: string; name: string; callback?: () => unknown; checkCallback?: (c: boolean) => boolean | void; editorCallback?: unknown }> = [];
  views = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  events: unknown[] = [];
  intervals: number[] = [];
  ribbons: Array<{ icon: string; title: string; cb: (evt: MouseEvent) => unknown }> = [];
  settingTabs: unknown[] = [];
  codeBlockProcessors = new Map<string, (source: string, el: HTMLElement, ctx: unknown) => unknown>();
  data: unknown = null;
  constructor(
    public app: unknown,
    public manifest: unknown = {},
  ) {
    super();
  }
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(d: unknown): Promise<void> {
    this.data = JSON.parse(JSON.stringify(d));
  }
  addCommand(c: Plugin["commands"][number]): Plugin["commands"][number] {
    this.commands.push(c);
    return c;
  }
  registerView(type: string, factory: (leaf: WorkspaceLeaf) => unknown): void {
    this.views.set(type, factory);
  }
  registerEvent(ref: unknown): void {
    this.events.push(ref);
  }
  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }
  addRibbonIcon(icon: string, title: string, cb: (evt: MouseEvent) => unknown): HTMLElement {
    this.ribbons.push({ icon, title, cb });
    return document.createElement("div");
  }
  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }
  registerMarkdownCodeBlockProcessor(lang: string, fn: (source: string, el: HTMLElement, ctx: unknown) => unknown): void {
    this.codeBlockProcessors.set(lang, fn);
  }
}

export const Platform = { isMobile: false, isIosApp: false, isDesktop: true };

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
