// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../testUtils/obsidian";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { FakeApp } from "../testUtils/fake-app";

let app: FakeApp;
let va: VaultAdapter;
beforeEach(() => {
  app = new FakeApp();
  va = new VaultAdapter(app as never);
  Notice.reset();
});

describe("reading", () => {
  it("reads text and binary files, and throws for a missing one", async () => {
    app.vault.seed("a.md", "hello");
    app.vault.seed("b.bin", new Uint8Array([1, 2]).buffer);
    expect(await va.readText("a.md")).toBe("hello");
    expect((await va.readBinary("b.bin")).byteLength).toBe(2);
    await expect(va.readText("nope.md")).rejects.toThrow("File not found: nope.md");
    await expect(va.readBinary("nope")).rejects.toThrow("File not found: nope");
  });

  it("answers exists / getFile / getMtime with normalised paths, and not for folders", () => {
    const f = app.vault.seed("dir/a.md", "x", 77);
    expect(va.exists("/dir/a.md")).toBe(true);
    expect(va.exists("dir/none.md")).toBe(false);
    expect(va.getFile("dir//a.md")).toBe(f);
    expect(va.getFile("dir")).toBeNull();
    expect(va.getMtime("dir/a.md")).toBe(77);
    expect(va.getMtime("none")).toBeNull();
  });

  it("lists markdown files under a folder, exact match included", () => {
    app.vault.seed("d/a.md");
    app.vault.seed("d/sub/b.md");
    app.vault.seed("d2/c.md");
    app.vault.seed("d/img.png");
    app.vault.seed("solo.md");
    expect(va.listMarkdownFiles("d").map((f) => f.path).sort()).toEqual(["d/a.md", "d/sub/b.md"]);
    expect(va.listMarkdownFiles("solo.md").map((f) => f.path)).toEqual(["solo.md"]);
  });
});

describe("writing", () => {
  it("creates a file with its folders, then updates it in place", async () => {
    const created = await va.writeText("x/y/z.md", "one");
    expect(app.vault.text("x/y/z.md")).toBe("one");
    const again = await va.writeText("x/y/z.md", "two");
    expect(again).toBe(created);
    expect(app.vault.text("x/y/z.md")).toBe("two");
  });

  it("writes a file in the vault root without making folders", async () => {
    await va.writeText("root.md", "r");
    expect(app.vault.text("root.md")).toBe("r");
  });

  it("refuses to write through a path that is a file", async () => {
    app.vault.seed("blocked", "i am a file");
    await expect(va.writeText("blocked/child.md", "x")).rejects.toThrow("Path collision: blocked");
  });

  it("writes binary files, creating then modifying", async () => {
    await va.writeBinary("img/a.png", new Uint8Array([1]).buffer);
    await va.writeBinary("img/a.png", new Uint8Array([1, 2, 3]).buffer);
    expect((app.vault.contents.get("img/a.png") as ArrayBuffer).byteLength).toBe(3);
  });

  it("ensures a folder idempotently and refuses a file in the way", async () => {
    await va.ensureFolder("a/b");
    await va.ensureFolder("a/b");
    await va.ensureFolder("");
    await va.ensureFolder("/");
    expect(app.vault.files.has("a/b")).toBe(true);
    app.vault.seed("file.md");
    await expect(va.ensureFolder("file.md")).rejects.toThrow("Path exists and is not a folder: file.md");
  });
});

describe("deleting and notices", () => {
  it("trashes through the file manager, and ignores a missing file", async () => {
    app.vault.seed("gone.md");
    await va.deleteFile("gone.md");
    await va.deleteFile("never.md");
    expect(app.trashed).toEqual(["gone.md"]);
  });

  it("shows a notice", () => {
    va.notice("hello", 5);
    expect(Notice.instances[0]).toMatchObject({ message: "hello", timeout: 5 });
  });
});

describe("backups", () => {
  it("copies a file beside itself with a timestamp, or returns null when missing", async () => {
    app.vault.seed("a.timeline", "<x/>");
    const dest = await va.backup("a.timeline");
    expect(dest).toMatch(/^a\.timeline\.bak-\d{4}-\d{2}-\d{2}T/);
    expect(app.vault.text(dest as string)).toBe("<x/>");
    expect(await va.backup("none")).toBeNull();
  });

  it("backs up a folder tree, or returns null when it has no markdown", async () => {
    app.vault.seed("ev/a.md", "A");
    app.vault.seed("ev/sub/b.md", "B");
    const dest = (await va.backupFolder("ev", "events", "bk")) as string;
    expect(dest).toMatch(/^bk\/events-/);
    expect(app.vault.text(`${dest}/a.md`)).toBe("A");
    expect(app.vault.text(`${dest}/sub/b.md`)).toBe("B");
    expect(await va.backupFolder("empty", "x", "bk")).toBeNull();
    app.vault.seed("single.md", "S");
    const one = (await va.backupFolder("single.md", "one", "bk")) as string;
    expect(app.vault.text(`${one}/single.md`)).toBe("S");
  });
});

describe("pruning", () => {
  it("ranks XML backups by the timestamp in their name, not by mtime", async () => {
    // A sync client re-downloading the backups gives them fresh, shuffled mtimes.
    app.vault.seed("t.timeline.bak-2026-01-01T00-00-00-000Z", "", 900);
    app.vault.seed("t.timeline.bak-2026-03-01T00-00-00-000Z", "", 100);
    app.vault.seed("t.timeline.bak-2026-02-01T00-00-00-000Z", "", 500);
    expect(await va.pruneXmlBackups("t.timeline", 1)).toBe(2);
    expect(app.trashed.sort()).toEqual([
      "t.timeline.bak-2026-01-01T00-00-00-000Z",
      "t.timeline.bak-2026-02-01T00-00-00-000Z",
    ]);
  });

  it("keeps only the newest XML backups", async () => {
    app.vault.seed("t.timeline.bak-1", "", 1);
    app.vault.seed("t.timeline.bak-2", "", 2);
    app.vault.seed("t.timeline.bak-3", "", 3);
    app.vault.seed("other.bak-9", "", 9);
    expect(await va.pruneXmlBackups("t.timeline", 1)).toBe(2);
    expect(app.trashed.sort()).toEqual(["t.timeline.bak-1", "t.timeline.bak-2"]);
    expect(await va.pruneXmlBackups("t.timeline", 5)).toBe(0);
    expect(await va.pruneXmlBackups("t.timeline", -1)).toBe(1);
  });

  it("keeps only the newest backup folders for a label", async () => {
    for (const n of ["events-2024-01", "events-2024-02", "events-2024-03", "other-2024-09"]) app.vault.seed(`bk/${n}/f.md`);
    expect(await va.pruneFolderBackups("events", 1, "bk")).toBe(2);
    expect(app.trashed.sort()).toEqual(["bk/events-2024-01", "bk/events-2024-02"]);
  });

  it("does nothing when the backup root is missing or is a file", async () => {
    expect(await va.pruneFolderBackups("events", 1, "nothing")).toBe(0);
    app.vault.seed("afile");
    expect(await va.pruneFolderBackups("events", 1, "afile")).toBe(0);
  });
});
