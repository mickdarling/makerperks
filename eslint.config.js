// Minimal flat ESLint config. Astro/TS type-checking is handled by `astro check`
// and `tsc`; ESLint here catches plain JS issues in scripts.
import js from "@eslint/js";

export default [
  {
    ignores: [
      "dist/",
      ".astro/",
      "node_modules/",
      "src/content/",
      "mcp-worker/",
      "worker/",
      "engagement-worker/",
      ".claude/skills/",
      ".github/skills/",
    ],
  },
  js.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
      },
    },
    rules: {
      // Allow the `const { slug: _slug, ...record } = a` omit-a-key idiom.
      "no-unused-vars": ["error", { varsIgnorePattern: "^_" }],
    },
  },
];
