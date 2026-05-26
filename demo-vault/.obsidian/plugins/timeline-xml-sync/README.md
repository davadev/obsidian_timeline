# Plugin install folder

The demo vault expects the plugin files **inside this folder**:

- `manifest.json` (required)
- `main.js` (required — bundles styles since 0.8.3)
- `styles.css` (optional but recommended — separate file for theming overrides)

Copy them from the latest [release](https://github.com/davadev/obsidian_timeline/releases), or run `npm run build` in the repo root and copy the files. Then open this folder as an Obsidian vault and enable **Timeline XML Sync** in Community plugins.

This README itself is harmless — Obsidian ignores extra files inside a plugin folder.
