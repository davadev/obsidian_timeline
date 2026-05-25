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
}
