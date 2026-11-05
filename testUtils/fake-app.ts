/**
 * An in-memory Obsidian `App`: just enough vault, metadata cache and workspace
 * for the plugin's own code to run against, with every interesting call
 * recorded. Not a re-implementation of Obsidian — only the surface the plugin
 * touches (see `grep "app\." src`).
 */
import { TAbstractFile, TFile, TFolder, WorkspaceLeaf } from "./obsidian";

type Listener = (...args: any[]) => unknown;

export class FakeVault {
  files = new Map<string, TAbstractFile>();
  contents = new Map<string, string | ArrayBuffer>();
  listeners = new Map<string, Listener[]>();
  /** Set to make the next call to the named method reject. */
  failNext = new Map<string, Error>();
  clock = 1_000;
  readonly root = Object.assign(new TFolder(), { path: "/", name: "" });

  private tick(): number {
    return ++this.clock;
  }

  private maybeFail(op: string): void {
    const e = this.failNext.get(op);
    if (e) {
      this.failNext.delete(op);
      throw e;
    }
  }

  /** Seed a file (and its folders) without firing events. */
  seed(path: string, content: string | ArrayBuffer = "", mtime?: number): TFile {
    this.mkdirs(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    const existing = this.files.get(path);
    if (existing instanceof TFile) {
      this.contents.set(path, content);
      existing.stat.mtime = mtime ?? this.tick();
      return existing;
    }
    const f = new TFile();
    f.path = path;
    f.name = path.slice(path.lastIndexOf("/") + 1);
    const dot = f.name.lastIndexOf(".");
    f.extension = dot >= 0 ? f.name.slice(dot + 1) : "";
    f.basename = dot >= 0 ? f.name.slice(0, dot) : f.name;
    f.stat = {
      mtime: mtime ?? this.tick(),
      ctime: 1,
      size: typeof content === "string" ? content.length : content.byteLength,
    };
    this.files.set(path, f);
    this.contents.set(path, content);
    this.attach(f);
    return f;
  }

  private attach(f: TAbstractFile): void {
    const idx = f.path.lastIndexOf("/");
    const parent = idx > 0 ? (this.files.get(f.path.slice(0, idx)) as TFolder) : this.root;
    f.parent = parent;
    if (!parent.children.includes(f)) parent.children.push(f);
  }

  mkdirs(folder: string): void {
    if (!folder) return;
    let acc = "";
    for (const part of folder.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      if (this.files.has(acc)) continue;
      const d = new TFolder();
      d.path = acc;
      d.name = part;
      this.files.set(acc, d);
      this.attach(d);
    }
  }

  on(name: string, fn: Listener): { name: string; fn: Listener } {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
    return { name, fn };
  }

  /** Fire a vault event to every registered handler. */
  emit(name: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path) ?? null;
  }
  getFiles(): TFile[] {
    return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }
  async read(f: TFile): Promise<string> {
    this.maybeFail("read");
    return this.contents.get(f.path) as string;
  }
  async cachedRead(f: TFile): Promise<string> {
    this.maybeFail("cachedRead");
    return this.contents.get(f.path) as string;
  }
  async readBinary(f: TFile): Promise<ArrayBuffer> {
    return this.contents.get(f.path) as ArrayBuffer;
  }
  async create(path: string, data: string): Promise<TFile> {
    this.maybeFail("create");
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    const f = this.seed(path, data);
    this.emit("create", f);
    return f;
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    return this.seed(path, data);
  }
  async createFolder(path: string): Promise<TFolder> {
    this.maybeFail("createFolder");
    if (this.files.has(path)) throw new Error(`Folder already exists: ${path}`);
    this.mkdirs(path);
    return this.files.get(path) as TFolder;
  }
  async process(f: TFile, fn: (data: string) => string): Promise<string> {
    this.maybeFail("process");
    const next = fn(this.contents.get(f.path) as string);
    this.contents.set(f.path, next);
    f.stat.mtime = this.tick();
    this.emit("modify", f);
    return next;
  }
  async modify(f: TFile, data: string): Promise<void> {
    this.contents.set(f.path, data);
    f.stat.mtime = this.tick();
    this.emit("modify", f);
  }
  async modifyBinary(f: TFile, data: ArrayBuffer): Promise<void> {
    this.contents.set(f.path, data);
    f.stat.mtime = this.tick();
  }
  getResourcePath(f: TFile): string {
    return `app://local/${f.path}`;
  }
  /** Remove a file or folder (what trashFile does). */
  remove(path: string): void {
    const f = this.files.get(path);
    if (!f) return;
    this.files.delete(path);
    this.contents.delete(path);
    if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
    if (f instanceof TFolder) {
      for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) this.remove(p);
    }
  }
  text(path: string): string {
    return this.contents.get(path) as string;
  }
}

export interface FakeLeaf extends WorkspaceLeaf {
  detached: boolean;
}

export class FakeApp {
  vault = new FakeVault();
  localStorage = new Map<string, unknown>();
  metaListeners = new Map<string, Listener[]>();
  frontmatter = new Map<string, Record<string, unknown> | undefined>();
  trashed: string[] = [];
  activeFile: TFile | null = null;
  activeView: unknown = null;
  openedLinks: Array<{ link: string; source: string; newLeaf: unknown }> = [];
  revealed: WorkspaceLeaf[] = [];
  leavesByType = new Map<string, WorkspaceLeaf[]>();
  rightLeaf: WorkspaceLeaf | null = new WorkspaceLeaf();
  mainLeaf: WorkspaceLeaf = new WorkspaceLeaf();

  metadataCache = {
    getFileCache: (f: TFile) => {
      const fm = this.frontmatter.get(f.path);
      return fm ? { frontmatter: fm } : null;
    },
    on: (name: string, fn: Listener) => {
      const list = this.metaListeners.get(name) ?? [];
      list.push(fn);
      this.metaListeners.set(name, list);
      return { name, fn };
    },
  };

  fileManager = {
    trashFile: async (f: TAbstractFile) => {
      this.trashed.push(f.path);
      this.vault.remove(f.path);
    },
  };

  workspace = {
    getActiveFile: () => this.activeFile,
    getActiveViewOfType: () => this.activeView,
    openLinkText: async (link: string, source: string, newLeaf?: unknown) => {
      this.openedLinks.push({ link, source, newLeaf });
    },
    getLeavesOfType: (t: string) => this.leavesByType.get(t) ?? [],
    getRightLeaf: () => this.rightLeaf,
    getLeaf: () => this.mainLeaf,
    revealLeaf: async (l: WorkspaceLeaf) => {
      this.revealed.push(l);
    },
  };

  loadLocalStorage = (k: string) => this.localStorage.get(k) ?? null;
  saveLocalStorage = (k: string, v: unknown) => {
    if (v === null) this.localStorage.delete(k);
    else this.localStorage.set(k, v);
  };

  /** Give a note frontmatter as the metadata cache would after indexing it. */
  index(path: string, frontmatter: Record<string, unknown> | undefined): void {
    this.frontmatter.set(path, frontmatter);
  }
}

export const fakeApp = (): FakeApp => new FakeApp();
