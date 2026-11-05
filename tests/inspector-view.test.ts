// @vitest-environment jsdom
import "../testUtils/setup-obsidian-dom";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer, Notice, WorkspaceLeaf } from "../testUtils/obsidian";
import { InspectorView, VIEW_TYPE_INSPECTOR } from "../src/obsidian/inspector-view";
import { TimelineCache } from "../src/obsidian/cache";
import { VaultAdapter } from "../src/obsidian/vault-adapter";
import { DEFAULT_SETTINGS, type TimelineXmlSyncSettings } from "../src/settings";
import { renderEventMarkdown } from "../src/timeline/markdown-writer";
import { parseEventNote } from "../src/timeline/markdown-parser";
import { parseEraNote } from "../src/timeline/era-md";
import type { TimelineEvent } from "../src/timeline/model";
import { FakeApp } from "../testUtils/fake-app";

const XML = `<?xml version="1.0" encoding="utf-8"?><timeline><version>2.11.0</version><categories/><events>
<event id="e1"><start>0100-01-01 00:00:00</start><end>0200-01-01 00:00:00</end><text>Xml event</text><period>True</period><show_time>True</show_time><fuzzy_start>True</fuzzy_start><fuzzy_end>False</fuzzy_end></event></events>
<eras><era><name>Old era</name><start>0001-01-01 00:00:00</start><end>0500-01-01 00:00:00</end><color>10,20,30</color></era></eras></timeline>`;

let app: FakeApp;
let settings: TimelineXmlSyncSettings;
let view: InspectorView;
let saved: ReturnType<typeof vi.fn>;
let selfWrites = 0;

const baseEvent = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "e1", text: "My event", start: { year: 1066, month: 10, day: 14 }, end: { year: 1066, month: 10, day: 14 }, isPoint: true,
  category: "War", ...over,
});

function seedEvent(ev: TimelineEvent = baseEvent(), path = "Events/e1.md", body?: string) {
  const text = renderEventMarkdown(ev, { sourceXmlPath: "t.timeline", timelineId: "main", body });
  app.vault.seed(path, text);
  app.index(path, { timeline_event_id: ev.id });
  return path;
}

async function build() {
  const cache = new TimelineCache(app as never, () => settings);
  const leaf = Object.assign(new WorkspaceLeaf(), { app });
  view = new InspectorView(leaf as never, {
    app: app as never, cache, vault: new VaultAdapter(app as never), getSettings: () => settings,
    withSelfWrite: async (fn) => { selfWrites++; return fn(); }, onEventSaved: saved as never,
  });
  await view.onOpen();
  return view;
}

const root = () => view.contentEl;
const rowInput = (label: string, sel = "input,textarea,select"): HTMLInputElement =>
  [...root().querySelectorAll(".txs-inspector-row")].find((r) => r.querySelector("label")?.textContent?.startsWith(label))!.querySelector(sel) as HTMLInputElement;
const selectIn = (label: string) => rowInput(label, "select") as unknown as HTMLSelectElement;
const type = (el: Element, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event("input"));
};
const toggleRow = (label: string) => [...root().querySelectorAll(".txs-inspector-toggle-row")].find((r) => r.querySelector("span")?.textContent === label)!;
const toggle = (label: string, on: boolean) => {
  const row = toggleRow(label);
  const box = row.querySelector("input") as HTMLInputElement;
  box.checked = on;
  box.dispatchEvent(new Event("change"));
};
const button = (text: string) => [...root().querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
const saveAndRead = async (path = "Events/e1.md") => {
  button("Save changes").click();
  await vi.waitFor(() => expect(saved).toHaveBeenCalled());
  return parseEventNote(app.vault.text(path), { path }).note!.event;
};

beforeEach(() => {
  Notice.reset();
  MarkdownRenderer.calls = [];
  MarkdownRenderer.fail = false;
  selfWrites = 0;
  saved = vi.fn();
  app = new FakeApp();
  settings = { ...DEFAULT_SETTINGS, eventNotesDir: "Events", sourceXmlPath: "t.timeline", knownCategories: ["War", "Peace"] };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("shell", () => {
  it("identifies itself and shows a hint before anything is loaded", async () => {
    await build();
    expect(view.getViewType()).toBe(VIEW_TYPE_INSPECTOR);
    expect(view.getDisplayText()).toBe("Timeline inspector");
    expect(view.getIcon()).toBe("info");
    expect(root().textContent).toContain("Click any event in a timeline render to inspect it.");
    await view.onClose();
    expect(root().children).toHaveLength(0);
  });

  it("explains an unknown event, a note that is not an event, and a read failure", async () => {
    app.vault.seed("Events/plain.md", "no frontmatter");
    app.index("Events/plain.md", { timeline_event_id: "plain" });
    seedEvent();
    await build();
    await view.loadEvent("ghost");
    expect(root().textContent).toContain('No note found for event id "ghost".');
    await view.loadEvent("plain");
    expect(root().textContent).toContain('Note at "Events/plain.md" is not a timeline event.');
    app.vault.failNext.set("read", new Error("disk"));
    await view.loadEvent("e1");
    expect(root().textContent).toBe("disk");
  });
});

describe("event form", () => {
  it("shows the event's fields and opens the note", async () => {
    seedEvent(baseEvent({ description: "Hello", labels: ["a", "b"], hyperlinks: ["http://x", "http://y"], container: "C", progress: 0.5, defaultColor: "10,20,30" }));
    await build();
    await view.loadEvent("e1");
    expect(root().querySelector("h3")?.textContent).toBe("My event");
    expect(rowInput("Title").value).toBe("My event");
    expect([...selectIn("Category").options].map((o) => o.value)).toEqual(["War", "Peace"]);
    expect(rowInput("Category", "select").value).toBe("War");
    expect(rowInput("Labels").value).toBe("a b");
    expect(rowInput("Hyperlinks").value).toBe("http://x\nhttp://y");
    expect(rowInput("Container").value).toBe("C");
    expect(rowInput("Progress").value).toBe("0.5");
    button("Open note").click();
    expect(app.openedLinks).toEqual([{ link: "Events/e1.md", source: "", newLeaf: false }]);
  });

  it("falls back to the event's own category when none are known, and an untitled heading", async () => {
    settings.knownCategories = [];
    seedEvent(baseEvent({ text: "", category: undefined }), "Events/e1.md", "# \n");
    await build();
    await view.loadEvent("e1");
    expect([...selectIn("Category").options].map((o) => o.value)).toEqual(["Uncategorized"]);
  });

  it("saves edits back to the note, keeping other frontmatter and refreshing caches", async () => {
    seedEvent(baseEvent());
    app.vault.seed("Events/e1.md", app.vault.text("Events/e1.md").replace("tags:", "custom: keepme\ntags:"));
    await build();
    await view.loadEvent("e1");
    type(rowInput("Title"), "Renamed");
    rowInput("Category", "select").value = "Peace";
    rowInput("Category", "select").dispatchEvent(new Event("change"));
    type(rowInput("Container"), "  Box ");
    type(rowInput("Labels"), "  one   two ");
    type(rowInput("Hyperlinks"), "http://a\n\n http://b ");
    type(rowInput("Role"), "event");
    type(rowInput("Timeline ID"), "other");
    type(rowInput("Source XML"), "o.timeline");
    type(rowInput("Progress"), "0.25");
    type(rowInput("Last synced"), "1234.9");
    const saved1 = await saveAndRead();
    expect(saved1).toMatchObject({
      text: "Renamed", category: "Peace", container: "Box", labels: ["one", "two"], hyperlinks: ["http://a", "http://b"],
      timelineId: "other", sourceXml: "o.timeline", progress: 0.25, lastSyncedXmlMtime: 1234,
    });
    expect(app.vault.text("Events/e1.md")).toContain("custom: keepme");
    expect(app.vault.text("Events/e1.md")).toContain("# Renamed");
    expect(Notice.messages()).toEqual(["Event note saved."]);
    expect(selfWrites).toBe(1);
  });

  it("clears optional fields when emptied, and ignores unusable numbers", async () => {
    seedEvent(baseEvent({ container: "C", progress: 0.5, hyperlinks: ["http://x"], defaultColor: "1,2,3" }));
    await build();
    await view.loadEvent("e1");
    type(rowInput("Container"), "");
    type(rowInput("Hyperlinks"), "");
    type(rowInput("Progress"), "");
    type(rowInput("Last synced"), "");
    type(rowInput("Role"), "");
    type(rowInput("Timeline ID"), "");
    type(rowInput("Source XML"), "");
    type(rowInput("Progress"), "abc");
    type(rowInput("Last synced"), "abc");
    type(rowInput("Event ID"), "   "); // blank ids are ignored
    const ev = await saveAndRead();
    expect(ev).toMatchObject({ container: undefined, progress: undefined, hyperlinks: undefined, hyperlink: undefined });
  });

  it("changes the event id", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    type(rowInput("Event ID"), " e2 ");
    expect((await saveAndRead()).id).toBe("e2");
  });

  it("edits the description with a debounced live preview that can be switched off", async () => {
    seedEvent(baseEvent({ description: "" }));
    await build();
    await view.loadEvent("e1");
    expect(root().textContent).toContain("(preview will render Markdown");
    vi.useFakeTimers();
    const area = rowInput("Description", "textarea");
    type(area, "a");
    type(area, "**bold**");
    expect(MarkdownRenderer.calls).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(MarkdownRenderer.calls.map((c) => c.markdown)).toEqual(["**bold**"]);
    const check = root().querySelector(".txs-inspector-preview-toggle input") as HTMLInputElement;
    check.checked = false;
    check.dispatchEvent(new Event("change"));
    expect(root().querySelector(".txs-inspector-preview")?.children).toHaveLength(0);
    vi.useRealTimers();
    expect((await saveAndRead()).description).toBe("**bold**");
  });

  it("shows the XML's values for flags the note leaves empty", async () => {
    seedEvent(baseEvent({ text: "Xml event", start: { year: 100 }, end: { year: 200 }, isPoint: false }));
    const path = "Events/e1.md";
    app.vault.seed(path, app.vault.text(path).replace(/  period:.*\n/, "  period: null\n").replace(/  show_time:.*\n/, "  show_time: null\n"));
    app.vault.seed("t.timeline", XML);
    await build();
    await view.loadEvent("e1");
    expect((toggleRow("Period (range event)").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect((toggleRow("Fuzzy start").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("does not consult the XML when the note already has the flags, has no XML, lacks the event, or fails to read it", async () => {
    const getXml = vi.spyOn(TimelineCache.prototype, "getXml");
    seedEvent(baseEvent({ period: false, showTime: false, fuzzyStart: false, fuzzyEnd: false }));
    await build();
    await view.loadEvent("e1");
    expect(getXml).not.toHaveBeenCalled();
    const blank = baseEvent();
    seedEvent(blank);
    settings.sourceXmlPath = "";
    await view.loadEvent("e1"); // nothing to fall back to
    settings.sourceXmlPath = "t.timeline";
    app.vault.seed("t.timeline", XML.replace('id="e1"', 'id="other"'));
    await view.loadEvent("e1"); // XML lacks this event
    app.vault.seed("t.timeline", "<not xml");
    getXml.mockRejectedValueOnce(new Error("bad xml"));
    await view.loadEvent("e1"); // unreadable XML
    expect(root().querySelector("h3")?.textContent).toBe("My event");
    getXml.mockRestore();
  });
});

const MINIMAL = "---\ntimeline:\n  enabled: true\n  event_id: min\n  start: {year: 5}\n  end: {year: 5}\n---\n# Minimal\n";

describe("hand-written notes", () => {
  const load = async () => {
    app.vault.seed("Events/min.md", MINIMAL);
    app.index("Events/min.md", { timeline_event_id: "min" });
    settings.knownCategories = [];
    await build();
    await view.loadEvent("min");
  };

  it("fills in sensible defaults for everything the note leaves out", async () => {
    await load();
    expect(rowInput("Timeline ID").value).toBe("main");
    expect(rowInput("Role").value).toBe("event");
    expect(rowInput("Source XML").value).toBe("t.timeline"); // the settings' path
    expect(rowInput("Last synced").value).toBe("");
    expect([...selectIn("Category").options].map((o) => o.value)).toEqual(["Uncategorized"]);
    expect((toggleRow("Render").querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect((toggleRow("Ends today").querySelector("input") as HTMLInputElement).checked).toBe(false);
    expect((toggleRow("Enabled").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("falls back to the settings' XML for flags the note lacks, or to nothing when none is set", async () => {
    app.vault.seed("t.timeline", XML.replace('id="e1"', 'id="min"'));
    settings.sourceXmlPath = "t.timeline";
    await load();
    expect((toggleRow("Fuzzy start").querySelector("input") as HTMLInputElement).checked).toBe(true);
    settings.sourceXmlPath = "";
    await view.loadEvent("min");
    expect((toggleRow("Fuzzy start").querySelector("input") as HTMLInputElement).checked).toBe(false);
  });

  it("shows a title that was cleared as untitled when the form redraws", async () => {
    await load();
    type(rowInput("Title"), "");
    toggle("Period (range event)", true);
    expect(root().querySelector("h3")?.textContent).toBe("(untitled)");
  });

  it("saves over a note that has stopped being an event", async () => {
    await load();
    app.vault.seed("Events/min.md", "scribbles, no frontmatter");
    type(rowInput("Title"), "Recovered");
    button("Save changes").click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());
    expect(app.vault.text("Events/min.md")).toContain("# Recovered");
  });

  it("shows the stored sync stamp when there is one", async () => {
    seedEvent(baseEvent({ lastSyncedXmlMtime: 99 }));
    await build();
    await view.loadEvent("e1");
    expect(rowInput("Last synced").value).toBe("99");
  });
});

describe("date behaviour", () => {
  const flag = (label: string) => toggleRow(label).querySelector("input") as HTMLInputElement;
  const dateInputs = (label: string) => [...[...root().querySelectorAll(".txs-date-row")].find((r) => r.querySelector("label")?.textContent === label)!.querySelectorAll<HTMLInputElement>("input")];

  it("a point event has one date and mirrors its end and fuzziness", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    expect(root().querySelectorAll(".txs-date-row")).toHaveLength(1);
    expect(root().textContent).toContain("Point event: end date/time follows start.");
    expect(root().textContent).toContain("Point event: fuzzy end mirrors fuzzy start.");
    toggle("Fuzzy start", true);
    expect(flag("Fuzzy start").checked).toBe(true);
    const ev = await saveAndRead();
    expect(ev).toMatchObject({ fuzzyStart: true, fuzzyEnd: true });
  });

  it("turning Period on shows an end date and its own fuzzy toggle", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    toggle("Period (range event)", true);
    expect(root().querySelectorAll(".txs-date-row")).toHaveLength(2);
    toggle("Fuzzy end", true);
    const end = dateInputs("End");
    type(end[0], "1100");
    type(end[1], "2");
    type(end[2], "");
    const ev = await saveAndRead();
    expect(ev).toMatchObject({ period: true, fuzzyEnd: true, end: { year: 1100, month: 2, day: undefined } });
  });

  it("turning Period off collapses the end onto the start", async () => {
    seedEvent(baseEvent({ end: { year: 1100 }, isPoint: false, period: true }));
    await build();
    await view.loadEvent("e1");
    toggle("Period (range event)", false);
    const ev = await saveAndRead();
    expect(ev.end).toEqual(ev.start);
    expect(ev.isPoint).toBe(true);
  });

  it("Show time reveals the clock fields; turning it off zeroes them", async () => {
    seedEvent(baseEvent({ start: { year: 1, month: 1, day: 1, hour: 5, minute: 6, second: 7 }, end: { year: 1, month: 1, day: 1, hour: 5, minute: 6, second: 7 } }));
    await build();
    await view.loadEvent("e1");
    expect(root().textContent).toContain("yyyy-mm-dd hh:mm:ss");
    const clock = dateInputs("Date");
    expect(clock.map((i) => i.placeholder)).toEqual(["year", "mm", "dd", "hh", "min", "sec"]);
    type(clock[3], "9");
    type(clock[3], "");
    type(clock[3], "9");
    type(clock[4], "x");
    type(clock[4], "15");
    type(clock[5], "30");
    type(clock[5], "");
    type(clock[5], "30");
    toggle("Show time", false);
    expect(dateInputs("Date")).toHaveLength(3);
    const ev = await saveAndRead();
    expect(ev.start).toMatchObject({ hour: 0, minute: 0, second: 0 });
  });

  it("edits year, month and day, ignoring a blank year", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    const [y, m, d] = dateInputs("Date");
    type(y, "");
    type(y, "1100");
    type(m, "");
    type(d, "20");
    const ev = await saveAndRead();
    expect(ev.start).toMatchObject({ year: 1100, month: undefined, day: 20 });
  });

  it("offers a native picker for CE dates and applies a change to start and end", async () => {
    seedEvent(baseEvent({ end: { year: 1100, month: 2, day: 3 }, isPoint: false, period: true }));
    await build();
    await view.loadEvent("e1");
    const [sp, ep] = [...root().querySelectorAll<HTMLInputElement>("input[type=date]")];
    expect(sp.value).toBe("1066-10-14");
    expect(ep.value).toBe("1100-02-03");
    sp.value = "1066-10-14"; // unchanged: no rerender
    sp.dispatchEvent(new Event("change"));
    sp.value = "not a date";
    sp.dispatchEvent(new Event("change"));
    sp.value = "1070-01-02";
    sp.dispatchEvent(new Event("change"));
    const ep2 = root().querySelectorAll<HTMLInputElement>("input[type=date]")[1];
    ep2.value = "1100-02-03";
    ep2.dispatchEvent(new Event("change"));
    ep2.value = "";
    ep2.dispatchEvent(new Event("change"));
    ep2.value = "1101-03-04";
    ep2.dispatchEvent(new Event("change"));
    const ev = await saveAndRead();
    expect(ev.start).toMatchObject({ year: 1070, month: 1, day: 2 });
    expect(ev.end).toMatchObject({ year: 1101, month: 3, day: 4 });
  });

  it("offers a single picker for a point event", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    expect(root().querySelectorAll("input[type=date]")).toHaveLength(1);
  });

  it("disables the picker for BCE dates, so an accidental tap cannot overwrite them", async () => {
    seedEvent(baseEvent({ start: { year: -44 }, end: { year: -44 } }));
    await build();
    await view.loadEvent("e1");
    expect(root().querySelector("input[type=date]")).toBeNull();
    expect(root().textContent).toContain("Quick picker disabled for BCE dates");
  });
});

describe("colour, flags, image", () => {
  it("syncs the colour picker and text, storing r,g,b", async () => {
    seedEvent(baseEvent({ defaultColor: "#ff0000" }));
    await build();
    await view.loadEvent("e1");
    const row = [...root().querySelectorAll(".txs-inspector-row")].find((r) => r.querySelector("label")?.textContent === "Default color")!;
    const [picker, text] = [...row.querySelectorAll<HTMLInputElement>("input")];
    expect(picker.value).toBe("#ff0000");
    type(picker, "#00ff00");
    expect(text.value).toBe("0,255,0");
    type(text, "rgb(1, 2, 3)");
    expect(picker.value).toBe("#010203");
    type(text, "#abc");
    expect(picker.value).toBe("#aabbcc");
    type(text, "nonsense");
    expect(picker.value).toBe("#888888");
    type(text, "");
    expect((await saveAndRead()).defaultColor).toBeUndefined();
  });

  it("stores a hex colour as-is when the picker value is not 6-digit hex", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    const row = [...root().querySelectorAll(".txs-inspector-row")].find((r) => r.querySelector("label")?.textContent === "Default color")!;
    const [picker, text] = [...row.querySelectorAll<HTMLInputElement>("input")];
    Object.defineProperty(picker, "value", { value: "red", configurable: true, writable: true });
    picker.dispatchEvent(new Event("input"));
    expect(text.value).toBe("red");
  });

  it("toggles the other flags", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    toggle("Enabled", false);
    toggle("Render", false);
    toggle("Ends today", true);
    toggle("Fuzzy", true);
    toggle("Locked", true);
    button("Save changes").click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());
    // A disabled event is no longer read back as an event, so check the YAML.
    const tl = (YAML.parse(app.vault.text("Events/e1.md").split("---\n")[1]) as { timeline: Record<string, unknown> }).timeline;
    expect(tl).toMatchObject({ enabled: false, render: false, ends_today: true, fuzzy: true, locked: true });
  });

  it("shows an existing image thumbnail, and uploads a new one", async () => {
    app.vault.seed("Events/_attachments/e1.png", new Uint8Array([1, 2]).buffer);
    seedEvent(baseEvent({ iconAttachmentPath: "Events/_attachments/e1.png" }));
    await build();
    await view.loadEvent("e1");
    expect((root().querySelector("img.txs-inspector-thumb") as HTMLImageElement).getAttribute("src")).toBe("app://local/Events/_attachments/e1.png");
    const input = root().querySelector("input[type=file]") as HTMLInputElement;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
    Object.defineProperty(input, "files", { value: [{ arrayBuffer: async () => png }], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(app.vault.files.has("Events/_attachments/e1.png")).toBe(true));
    await vi.waitFor(() => expect(root().querySelector("input[type=file]")).not.toBeNull());
    expect(root().textContent).toContain("Events/_attachments/e1.png");
  });

  it("ignores a missing attachment file and an empty selection, and reports upload failures", async () => {
    seedEvent(baseEvent({ iconAttachmentPath: "Events/_attachments/gone.png" }));
    await build();
    await view.loadEvent("e1");
    expect(root().querySelector("img")).toBeNull();
    const input = root().querySelector("input[type=file]") as HTMLInputElement;
    input.dispatchEvent(new Event("change")); // no files
    Object.defineProperty(input, "files", { value: [{ arrayBuffer: async () => { throw new Error("unreadable"); } }], configurable: true });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(Notice.messages()).toContain("Image upload failed: unreadable"));
  });

  it("Reload from note re-reads the file", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    type(rowInput("Title"), "Edited but unsaved");
    button("Reload from note").click();
    await vi.waitFor(() => expect(rowInput("Title").value).toBe("My event"));
  });

  it("reports a failed save", async () => {
    seedEvent();
    await build();
    await view.loadEvent("e1");
    app.vault.failNext.set("read", new Error("locked"));
    button("Save changes").click();
    await vi.waitFor(() => expect(Notice.messages()).toContain("Save failed: locked"));
    expect(saved).not.toHaveBeenCalled();
  });

  it("saves into a note whose body lacks the sections, and when the note has no parseable body", async () => {
    seedEvent(baseEvent({ description: "keep" }), "Events/e1.md", "Just prose with no headings.\n");
    await build();
    await view.loadEvent("e1");
    type(rowInput("Title"), "T2");
    type(rowInput("Description", "textarea"), "keep");
    await saveAndRead();
    const text = app.vault.text("Events/e1.md");
    expect(text).toContain("# T2");
    expect(text).toContain("## Text\n\nT2");
    expect(text).toContain("## Description\n\nkeep");
  });

  it("rewrites existing sections in place and leaves fenced headings alone", async () => {
    const body = "# Old\n\n## Text\n\nold text\n\n## Description\n\nold\n```\n# not a heading\n```\n\n## Timeline\n\nkeep this\n";
    seedEvent(baseEvent({ description: "old" }), "Events/e1.md", body);
    await build();
    await view.loadEvent("e1");
    type(rowInput("Title"), "New");
    type(rowInput("Description"), "fresh");
    await saveAndRead();
    const text = app.vault.text("Events/e1.md");
    expect(text).toContain("# New\n");
    expect(text).toContain("## Text\nNew");
    expect(text).toContain("## Description\nfresh");
    expect(text).toContain("## Timeline\n\nkeep this");
    expect(text).not.toContain("old text");
  });

  it("writes the last section to the end when nothing follows it", async () => {
    seedEvent(baseEvent(), "Events/e1.md", "# T\n\n## Text\n\nold\n\n## Description\n\nold desc");
    await build();
    await view.loadEvent("e1");
    type(rowInput("Description"), "new desc");
    await saveAndRead();
    expect(app.vault.text("Events/e1.md")).toMatch(/## Description\nnew desc$/);
  });
});

describe("era form", () => {
  beforeEach(() => {
    app.vault.seed("t.timeline", XML);
    settings.eventSource = "xml";
  });

  it("explains an unknown era and read failures", async () => {
    await build();
    await view.loadEra("nope");
    expect(root().textContent).toContain('No era found with id "nope".');
    settings.sourceXmlPath = "missing.timeline";
    await view.loadEra("old-era");
    expect(root().textContent).toContain("XML not found");
  });

  it("shows the era, opens its note when it has one, and saves edits to Markdown", async () => {
    app.vault.seed("Events/_eras/old-era.md", "x");
    await build();
    await view.loadEra("old-era");
    expect(root().querySelector("h3")?.textContent).toBe("Old era — (era)");
    button("Open era note").click();
    expect(app.openedLinks[0].link).toBe("Events/_eras/old-era.md");
    const rows = [...root().querySelectorAll(".txs-inspector-row")];
    const input = (label: string, n = 0) => rows.filter((r) => r.querySelector("label")?.textContent === label)[n];
    type(input("Name").querySelector("input")!, "Renamed era");
    const [sy, sm, sd] = [...input("Start").querySelectorAll<HTMLInputElement>("input")];
    type(sy, "5"); type(sy, ""); type(sm, "6"); type(sm, ""); type(sd, "7"); type(sd, "x");
    const [ey] = [...input("End").querySelectorAll<HTMLInputElement>("input")];
    type(ey, "600");
    const [picker, text] = [...input("Color").querySelectorAll<HTMLInputElement>("input")];
    expect(picker.value).toBe("#0a141e");
    type(picker, "#00ff00");
    expect(text.value).toBe("0,255,0");
    Object.defineProperty(picker, "value", { value: "red", configurable: true, writable: true });
    picker.dispatchEvent(new Event("input"));
    expect(text.value).toBe("red");
    type(text, "  ");
    expect(picker.value).toBe("#888888");
    type(text, "1,2,3");
    button("Save era").click();
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());
    const era = parseEraNote(app.vault.text("Events/_eras/old-era.md"), "f");
    expect(era).toMatchObject({ id: "old-era", name: "Renamed era", color: "1,2,3", end: { year: 600 } });
    expect(Notice.messages()).toEqual(["Era saved to Markdown. XML updates on next sync."]);
  });

  it("has no open button for an era without a note, and can reload from the source", async () => {
    await build();
    await view.loadEra("old-era");
    expect(button("Open era note")).toBeUndefined();
    type([...root().querySelectorAll(".txs-inspector-row input")][0], "Changed");
    button("Reload from note").click();
    await vi.waitFor(() => expect(([...root().querySelectorAll(".txs-inspector-row input")][0] as HTMLInputElement).value).toBe("Old era"));
  });

  it("saves a first note for an era that had none, and reports a failed save", async () => {
    await build();
    await view.loadEra("old-era");
    button("Save era").click();
    await vi.waitFor(() => expect(app.vault.files.has("Events/_eras/old-era.md")).toBe(true));
    button("Open era note");
    app.vault.failNext.set("create", new Error("full"));
    app.vault.remove("Events/_eras/old-era.md");
    button("Save era").click();
    await vi.waitFor(() => expect(Notice.messages()).toContain("Era save failed: full"));
  });

  it("shows an era with no colour", async () => {
    app.vault.seed("t.timeline", XML.replace("<color>10,20,30</color>", ""));
    await build();
    await view.loadEra("old-era");
    const row = [...root().querySelectorAll(".txs-inspector-row")].find((r) => r.querySelector("label")?.textContent === "Color")!;
    expect((row.querySelectorAll("input")[0] as HTMLInputElement).value).toBe("#888888");
    expect((row.querySelectorAll("input")[1] as HTMLInputElement).value).toBe("");
  });
});
