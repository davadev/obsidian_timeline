# XML compatibility notes

Built and tested against **Timeline Project 2.11** save files (`<version>2.11.0</version>`, `<timetype>gregoriantime</timetype>`).

The XML parser/writer is defensive — unknown attributes and child elements survive a round-trip — so other Timeline versions should work, but only 2.11 is the verified target.

## What round-trips

- **Event ordering** preserved.
- **Unknown event/category child elements** preserved verbatim and re-emitted unchanged when the event is round-tripped.
- **Categories not referenced by any event** kept.
- **`<view>` block** (displayed period, hidden categories) preserved.
- **CDATA** in descriptions preserved (so `<bracketed>`, `&amp;`, etc. don't double-encode).
- **`<icon>`** (base64 PNG/JPG/WebP) round-trips via vault attachments.
- **`<era>`** bands have dedicated MD notes under `_eras/`, editable through the Inspector.

## What new MD events add

- New categories introduced by Markdown notes are appended with a neutral `200,200,200` colour — adjust in Timeline Project or via the Settings → Category colors panel.
- Stable XML `id` attribute auto-generated from a slug of the event title if not provided.

## Known untested / TODO

Confirm against your real save file once you drop it in:

- Container / sub-event nesting (some Timeline versions emit nested `<event>` for milestones).
- `progress`, `alert`, `default_color` fields — written when present, but the exact wire format from Timeline 2.11 should be cross-checked.
- Time-type values other than `gregoriantime`.

## Entity expansion

fast-xml-parser has a 1000-entity hard cap that some real-world Timeline saves hit. The plugin disables `processEntities` on parse and decodes entities manually instead — the cap is bypassed and round-trips remain correct. The writer still encodes entities normally on output.
