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
      "testUtils/**",
      "docs/**",
      // Build/test tooling, not plugin code: outside tsconfig's program, so
      // the typed rules in obsidianmd's recommended set cannot run on it.
      "*.config.ts",
      "*.config.mts",
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
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // The auto-review marks bare `any` as an Error.
      "@typescript-eslint/no-explicit-any": "error",

      // The auto-review surfaces these as Warnings (non-blocking there, blocking
      // here via --max-warnings 0). Declaring them as `warn` is what keeps
      // `npm run lint:cloud-parity` at zero ERRORS in the review's type-blind view.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-deprecated": "warn",
      // The rule behind the "'X' is an 'error' type that acts as 'any'" rows
      // that head the review's report (the scanner could not resolve a type).
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-object-type": "off",
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
