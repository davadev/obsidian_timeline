# Install

Three files ship: `manifest.json`, `main.js`, `styles.css`. Drop them into `.obsidian/plugins/timeline-xml-sync/` inside your vault.

> Since 0.8.3 the CSS is also bundled inside `main.js` and auto-injected at load time, so the plugin's UI looks correct even when `styles.css` is missing. The separate file is still recommended (themes can override individual rules), but the plugin no longer breaks visually without it.

## Desktop (easiest)

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest [release](https://github.com/davadev/obsidian_timeline/releases).
2. In your vault, create the folder `.obsidian/plugins/timeline-xml-sync/` (turn on "Show hidden files" if you can't see `.obsidian`).
3. Move the three files into that folder.
4. Open Obsidian → **Settings → Community plugins** → toggle off **Restricted mode** if needed → click **Reload plugins** → enable **Timeline XML Sync**.

## Mobile (iPhone / iPad / Android)

The plugin is mobile-safe but Obsidian Mobile cannot download release ZIPs directly. Pick whichever route matches your sync setup:

### A. Vault sync that includes `.obsidian/` (Obsidian Sync, Syncthing, iCloud full-vault)

1. Install on desktop using the steps above.
2. Sync the vault — the plugin folder rides along under `.obsidian/plugins/timeline-xml-sync/`.
3. On the phone, **Settings → Community plugins → Installed plugins** → enable **Timeline XML Sync**.

### B. Vault sync that excludes plugin config (Remotely Save, Obsidian Sync with config sharing off, partial sync)

Two good options, no full-config sync needed:

- **BRAT (recommended)** — install the [Obsidian42 BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from the community catalog (works on iOS), then in BRAT settings **Add beta plugin** with the repo `davadev/obsidian_timeline`. BRAT downloads the latest release assets straight into your phone's vault and keeps the plugin updated. Enable it in Community plugins afterwards.
- **Files app (manual)** — on iOS open the **Files** app → **On My iPhone → Obsidian → \<your vault\>**. If `.obsidian` is hidden, tap the three-dot menu → **Show All**. Create `.obsidian/plugins/timeline-xml-sync/` and drop in the three release files. Restart Obsidian and enable the plugin. Same path works on Android via any file manager.

### C. Quick one-shot transfer

- **AirDrop / Quick Share** the three release files from a desktop into the Obsidian vault folder using the Files app.
- **a-Shell** (free iOS terminal) can `curl` the release assets and `mv` them under `.obsidian/plugins/…`.

> The plugin uses only the Obsidian Vault API and browser DOM/SVG — no Node, no Electron, no native modules — so it works on iOS the same way it does on desktop.

## From source

```bash
git clone https://github.com/davadev/obsidian_timeline.git
cd obsidian_timeline
npm install
npm run build
# copy manifest.json, main.js, styles.css into your vault as above
```

For development with live rebuild:

```bash
npm run dev
```

## First run

Once the plugin is enabled it auto-detects:

1. A `.timeline` XML file anywhere in your vault → sets it as the source.
2. Notes with `timeline.enabled: true` in frontmatter → infers the event notes directory.

If you have only an XML file: run **Timeline XML Sync: Import XML to Markdown event notes**. The plugin creates one MD per event.

If you have only Markdown event notes (no XML): they render fine. Set **Event source for rendering** to `md` in settings.

If you have neither: try the [demo vault](../demo-vault/) — it ships a public-domain Roman timeline.
