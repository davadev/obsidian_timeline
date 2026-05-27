import { Notice, TFile, TFolder, normalizePath, type App } from "obsidian";

/**
 * Thin wrapper around the Obsidian Vault API.
 * Pure logic modules never import this — they receive plain strings/objects.
 * All file IO routes through Vault so it works on mobile (no fs/path/electron).
 */
export class VaultAdapter {
  constructor(private app: App) {}

  async readText(path: string): Promise<string> {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return this.app.vault.read(file);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return this.app.vault.readBinary(file);
  }

  exists(path: string): boolean {
    const np = normalizePath(path);
    return this.app.vault.getAbstractFileByPath(np) != null;
  }

  /**
   * Write a file using Vault.process() when it already exists (atomic + safe
   * against concurrent edits in Obsidian). Otherwise create the file (and any
   * intermediate folders).
   */
  async writeText(path: string, content: string): Promise<TFile> {
    const np = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(np);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content);
      return existing;
    }
    await this.ensureFolderFor(np);
    return this.app.vault.create(np, content);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const np = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(np);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      return existing;
    }
    await this.ensureFolderFor(np);
    return this.app.vault.createBinary(np, data);
  }

  async deleteFile(path: string): Promise<void> {
    const file = this.getFile(path);
    if (!file) return;
    await this.app.vault.delete(file);
  }

  async ensureFolder(path: string): Promise<void> {
    const np = normalizePath(path);
    if (!np || np === "/") return;
    const existing = this.app.vault.getAbstractFileByPath(np);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error(`Path exists and is not a folder: ${np}`);
    await this.app.vault.createFolder(np);
  }

  private async ensureFolderFor(filePath: string): Promise<void> {
    const idx = filePath.lastIndexOf("/");
    if (idx <= 0) return;
    const folder = filePath.slice(0, idx);
    // createFolder creates intermediates as needed via recursive walk.
    const parts = folder.split("/");
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      const ex = this.app.vault.getAbstractFileByPath(acc);
      if (ex instanceof TFolder) continue;
      if (ex) throw new Error(`Path collision: ${acc}`);
      await this.app.vault.createFolder(acc);
    }
  }

  getFile(path: string): TFile | null {
    const np = normalizePath(path);
    const a = this.app.vault.getAbstractFileByPath(np);
    return a instanceof TFile ? a : null;
  }

  listMarkdownFiles(folder: string): TFile[] {
    const np = normalizePath(folder);
    const out: TFile[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path === np || f.path.startsWith(np + "/")) out.push(f);
    }
    return out;
  }

  notice(msg: string, timeoutMs?: number): void {
    new Notice(msg, timeoutMs);
  }

  /** Save a copy of `path` to `path.bak-<timestamp>` (without touching the original). */
  async backup(path: string): Promise<string | null> {
    const file = this.getFile(path);
    if (!file) return null;
    const content = await this.app.vault.read(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${path}.bak-${stamp}`;
    await this.writeText(dest, content);
    return dest;
  }

  /** mtime of a file in epoch ms, or null if missing. */
  getMtime(path: string): number | null {
    const f = this.getFile(path);
    return f ? f.stat.mtime : null;
  }

  /**
   * Copy every markdown file under `srcFolder` to a fresh
   * `<backupRoot>/<label>-<ISO-stamp>/` folder. Preserves subdir layout.
   * Returns the backup folder path, or null if srcFolder has no MD files.
   */
  async backupFolder(
    srcFolder: string,
    label: string,
    backupRoot: string
  ): Promise<string | null> {
    const files = this.listMarkdownFiles(srcFolder);
    if (!files.length) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${normalizePath(backupRoot)}/${label}-${stamp}`;
    await this.ensureFolder(dest);
    const src = normalizePath(srcFolder);
    for (const f of files) {
      const rel = f.path === src ? f.name : f.path.slice(src.length + 1);
      const content = await this.app.vault.read(f);
      await this.writeText(`${dest}/${rel}`, content);
    }
    return dest;
  }

  /**
   * Keep only the most recent `keep` XML backup siblings of `originalXmlPath`
   * (files matching `<originalXmlPath>.bak-*`). Returns the count deleted.
   */
  async pruneXmlBackups(originalXmlPath: string, keep: number): Promise<number> {
    const np = normalizePath(originalXmlPath);
    const prefix = `${np}.bak-`;
    const all = this.app.vault.getFiles().filter((f) => f.path.startsWith(prefix));
    all.sort((a, b) => b.stat.mtime - a.stat.mtime); // newest first
    let deleted = 0;
    for (const f of all.slice(Math.max(0, keep))) {
      await this.app.vault.delete(f);
      deleted++;
    }
    return deleted;
  }

  /**
   * Keep only the most recent `keep` `<backupRoot>/<label>-*` folders.
   * Names sort chronologically (ISO timestamp), so localeCompare suffices.
   */
  async pruneFolderBackups(
    label: string,
    keep: number,
    backupRoot: string
  ): Promise<number> {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(backupRoot));
    if (!root || !(root instanceof TFolder)) return 0;
    const matches = root.children
      .filter(
        (c): c is TFolder =>
          c instanceof TFolder && c.name.startsWith(label + "-")
      )
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first
    let deleted = 0;
    for (const f of matches.slice(Math.max(0, keep))) {
      await this.app.vault.delete(f, true);
      deleted++;
    }
    return deleted;
  }
}
