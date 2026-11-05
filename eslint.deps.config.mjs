// Lints package.json for dependencies that have a modern replacement (the
// review's "should be replaced with an alternative package" warning, from the
// es-tooling module-replacements list). `npm run lint:deps` runs it, with zero
// warnings allowed. List a package in `allowed` only with the reason above it.
import depend from "eslint-plugin-depend";
import * as jsonc from "jsonc-eslint-parser";

export default [
  {
    files: ["package.json"],
    languageOptions: { parser: jsonc },
    plugins: { depend },
    rules: { "depend/ban-dependencies": "error" },
  },
];
