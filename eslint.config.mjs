import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

// Mirrors the eslint-plugin-obsidianmd severities used by the community-plugin
// review, so a release is blocked locally by anything that would be flagged
// there. See docs/releasing.md.
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "demo-vault/**",
      "coverage/**",
      // Tests are not shipped and are not part of the community review; they
      // use Node APIs and DOM shims the plugin rules rightly flag.
      "tests/**",
      "docs/**",
      // Build/test tooling, not plugin code: outside tsconfig's program, so
      // the typed rules in obsidianmd's recommended set cannot run on it.
      "*.config.ts",
      "*.mjs",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  {
    // Typed rules (obsidianmd's recommended set pulls several in) need the
    // TypeScript program.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...tseslint.configs.recommended,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // Custom arrays REPLACE the plugin's defaults (see
      // sentenceCaseUtil.js: `options?.acronyms ?? DEFAULT_ACRONYMS`), so this
      // is the full list, not an addition to one.
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: [
            "Obsidian",
            "Obsidian Sync",
            "Timeline XML Sync",
            "Timeline Project",
            "Markdown",
            "Nextcloud",
            "Remotely Save",
            "iCloud",
            "iOS",
            "Android",
            "GitHub",
            // Deliberately no "Cursor": the default brand list capitalises
            // the word in "insert block at cursor".
          ],
          acronyms: [
            "XML",
            "CSS",
            "HTML",
            "JSON",
            "YAML",
            "PNG",
            "SVG",
            "URL",
            "API",
            "UI",
            "ID",
            "TTL",
            "MS",
            "CE",
            "BCE",
          ],
          ignoreRegex: [
            // Bare URLs / domains shown as link text.
            "^(https?://|[a-z0-9-]+(\\.[a-z0-9-]+)+(/|$))",
            // Vault-relative paths used as placeholders.
            "^[\\w.-]+/",
            // Colour samples: "#aabbcc or rgb(…)", "r,g,b or #hex".
            "^#[0-9a-fA-F]",
            "^r,g,b",
          ],
        },
      ],
    },
  },
);
