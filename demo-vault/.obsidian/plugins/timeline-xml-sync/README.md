# Plugin install folder

The demo vault expects the plugin files **inside this folder**:

- `manifest.json` (required)
- `main.js` (required)
- `styles.css` (required — Obsidian loads it; without it the UI is unstyled)

Copy them from the latest [release](https://github.com/davadev/obsidian_timeline/releases), or run `npm run build` in the repo root and copy the files. Then open this folder as an Obsidian vault and enable **Timeline XML Sync** in Community plugins.

This README itself is harmless — Obsidian ignores extra files inside a plugin folder.
