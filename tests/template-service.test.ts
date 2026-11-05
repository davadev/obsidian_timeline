// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice, Setting } from "../testUtils/obsidian";
import { TemplateService } from "../src/obsidian/template-service";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { parseEventNote } from "../src/timeline/markdown-parser";
import { parseEraNote } from "../src/timeline/era-md";
import { FakeApp } from "../testUtils/fake-app";

let app: FakeApp;
let vault: VaultAdapter;
let cfg: { templatesDir: string; eventNotesDir: string; timelineId: string; sourceXmlPath: string; trimDescriptionOnWrite: boolean };
let svc: TemplateService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-05-06T07:08:09Z"));
  app = new FakeApp();
  vault = new VaultAdapter(app as never);
  cfg = { templatesDir: "Templates", eventNotesDir: "Events", timelineId: "main", sourceXmlPath: "t.timeline", trimDescriptionOnWrite: true };
  svc = new TemplateService(app as never, vault, () => cfg);
  Notice.reset();
  Modal.instances.length = 0;
  Setting.instances.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("template", () => {
  it("lives in the templates folder", () => {
    expect(svc.templatePath()).toBe("Templates/Timeline Event.md");
  });

  it("writes an Obsidian-Templates compatible template, using the configured ids", async () => {
    cfg.timelineId = "custom";
    cfg.sourceXmlPath = "x/y.timeline";
    const path = await svc.createOrUpdateTemplate();
    expect(path).toBe("Templates/Timeline Event.md");
    const text = app.vault.text(path);
    expect(text).toContain("id: custom");
    expect(text).toContain("source_xml: x/y.timeline");
    expect(text).toContain("{{title}}");
    await svc.createOrUpdateTemplate(); // updating in place
  });

  it("refuses without a templates folder", async () => {
    cfg.templatesDir = "";
    await expect(svc.createOrUpdateTemplate()).rejects.toThrow("Templates directory not configured");
  });
});

describe("createNewEventNote", () => {
  it("creates a point event dated today, with a stamped id and a slug filename", async () => {
    const { path, eventId } = await svc.createNewEventNote("Battle of Marathon");
    expect(path).toBe("Events/battle-of-marathon.md");
    expect(eventId).toBe("battle-of-marathon-2024-05-06-070809");
    const parsed = parseEventNote(app.vault.text(path), { path }).note?.event;
    expect(parsed).toMatchObject({ id: eventId, text: "Battle of Marathon", isPoint: true, category: "Uncategorized", start: { year: 2024, month: 1, day: 1 } });
  });

  it("never overwrites an existing note with the same title", async () => {
    const first = await svc.createNewEventNote("Meeting");
    app.vault.seed(first.path, "my own edits");
    const second = await svc.createNewEventNote("Meeting");
    const third = await svc.createNewEventNote("Meeting");
    expect([second.path, third.path]).toEqual(["Events/meeting-2.md", "Events/meeting-3.md"]);
    expect(app.vault.text(first.path)).toBe("my own edits");
  });

  it("gives events created in the same minute different ids", async () => {
    const a = await svc.createNewEventNote("Same");
    vi.setSystemTime(new Date("2024-05-06T07:08:10Z"));
    const b = await svc.createNewEventNote("Same");
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("falls back to default names for an empty title, and needs a folder", async () => {
    const { path } = await svc.createNewEventNote("");
    expect(path).toBe("Events/event.md");
    expect(parseEventNote(app.vault.text(path), { path }).note?.event.text).toBe("New event");
    cfg.eventNotesDir = "";
    await expect(svc.createNewEventNote("x")).rejects.toThrow("Event notes directory not configured.");
  });
});

/** The modal the service opened, once it has had a chance to. */
const modal = () => Modal.instances[Modal.instances.length - 1];
const setting = (i: number) => Setting.instances[i];
const button = (m: Modal, label: string) => [...m.contentEl.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("createNewEventInteractive", () => {
  const callbacks = () => ({ openNote: vi.fn(async () => {}), openInspector: vi.fn(async () => {}) });

  it("skips the dialog when a title is given, then opens the note and the inspector", async () => {
    const cb = callbacks();
    await svc.createNewEventInteractive(cb.openNote, cb.openInspector, "Given");
    expect(Modal.instances).toHaveLength(0);
    expect(cb.openNote).toHaveBeenCalledWith("Events/given.md");
    expect(cb.openInspector).toHaveBeenCalledWith("given-2024-05-06-070809", "Events/given.md");
    expect(Notice.messages()).toEqual(["Created Events/given.md"]);
  });

  it("creates from the dialog's Create button", async () => {
    const cb = callbacks();
    const done = svc.createNewEventInteractive(cb.openNote, cb.openInspector);
    const m = modal();
    expect(m.titleEl.textContent).toBe("New timeline event");
    button(m, "Create").click(); // empty: ignored
    await setting(0).text[0].type("  Typed  ");
    button(m, "Create").click();
    await done;
    expect(cb.openNote).toHaveBeenCalledWith("Events/typed.md");
  });

  it("creates on Enter, ignoring Enter on an empty title and other keys", async () => {
    const cb = callbacks();
    const done = svc.createNewEventInteractive(cb.openNote, cb.openInspector);
    const input = setting(0).text[0].inputEl;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await setting(0).text[0].type("Via enter");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await done;
    expect(cb.openNote).toHaveBeenCalledWith("Events/via-enter.md");
    vi.runAllTimers(); // the deferred focus
  });

  it("does nothing when cancelled or closed", async () => {
    const cb = callbacks();
    const a = svc.createNewEventInteractive(cb.openNote, cb.openInspector);
    button(modal(), "Cancel").click();
    await a;
    const b = svc.createNewEventInteractive(cb.openNote, cb.openInspector);
    modal().close();
    await b;
    expect(cb.openNote).not.toHaveBeenCalled();
    expect(app.vault.getFiles()).toHaveLength(0);
  });
});

describe("createNewEraInteractive", () => {
  const fill = async (m: Modal, v: Record<string, string>) => {
    const inputs = [...m.contentEl.querySelectorAll("input")];
    const by = (ph: string, n = 0) => inputs.filter((i) => i.placeholder === ph)[n];
    const type = (el: HTMLInputElement | undefined, val?: string) => {
      if (!el || val == null) return;
      el.value = val;
      el.dispatchEvent(new Event("input"));
    };
    if (v.name != null) await setting(0).text[0].type(v.name);
    type(by("year", 0), v.sy);
    type(by("mm", 0), v.sm);
    type(by("dd", 0), v.sd);
    type(by("year", 1), v.ey);
    type(by("mm", 1), v.em);
    type(by("dd", 1), v.ed);
    if (v.color != null) await setting(1).text[0].type(v.color);
  };

  it("writes an era note from the dialog and opens it in the inspector", async () => {
    const open = vi.fn(async () => {});
    const done = svc.createNewEraInteractive(vault, open);
    const m = modal();
    expect(m.titleEl.textContent).toBe("New era");
    await fill(m, { name: " Bronze Age ", sy: "-3300", sm: "1", sd: "2", ey: "-1200", em: "x", ed: "", color: " 1,2,3 " });
    button(m, "Create").click();
    await done;
    const id = "bronze-age-2024-05-06-070809";
    const text = app.vault.text(`Events/_eras/${id}.md`);
    expect(parseEraNote(text, "f")).toMatchObject({ id, name: "Bronze Age", color: "1,2,3", start: { year: -3300, month: 1, day: 2 }, end: { year: -1200, month: undefined } });
    expect(open).toHaveBeenCalledWith(id);
    expect(Notice.messages()).toEqual(["Created era Bronze Age"]);
  });

  it("leaves the colour out when blank", async () => {
    const done = svc.createNewEraInteractive(vault, async () => {});
    await fill(modal(), { name: "Plain", sy: "1", ey: "2" });
    button(modal(), "Create").click();
    await done;
    expect(parseEraNote(app.vault.text("Events/_eras/plain-2024-05-06-070809.md"), "f")?.color).toBeUndefined();
  });

  it("insists on a name and both years", async () => {
    const open = vi.fn(async () => {});
    const done = svc.createNewEraInteractive(vault, open);
    const m = modal();
    button(m, "Create").click();
    await fill(m, { name: "Named", sy: "1" });
    button(m, "Create").click();
    await fill(m, { ey: "x" });
    button(m, "Create").click();
    expect(Notice.messages()).toEqual(Array(3).fill("Name + start year + end year are required."));
    button(m, "Cancel").click();
    await done;
    expect(open).not.toHaveBeenCalled();
  });
});
