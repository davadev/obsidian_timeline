// Lints styles.css with the checks Obsidian's community-plugin review applies:
//   - declaration-no-important
//   - declaration-block-no-duplicate-properties (put an engine fallback in an
//     @supports block after the base rule instead of a second declaration)
//   - selector-pseudo-class-disallowed-list: `:has` (broad selector
//     invalidation; use :focus-within, a class set in code, or a line decoration)
//   - stylelint-no-unsupported-browser-features, "only partially supported"
//
// The browser target is a calibrated guess at the engine of the Obsidian build
// the review runs against, not a published fact. Both are `error` here although
// the review shows the browser-feature ones as warnings: a warning in the
// review is still a finding on the plugin's page, so CI treats it as a failure.
export default {
  plugins: ["stylelint-no-unsupported-browser-features"],
  rules: {
    "declaration-no-important": true,
    "declaration-block-no-duplicate-properties": true,
    "selector-pseudo-class-disallowed-list": ["has"],
    "plugin/no-unsupported-browser-features": [true, { browsers: ["chrome 138"], severity: "error" }],
  },
};
