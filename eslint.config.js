import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        // Node 20 globals
        console: "readonly",
        process: "readonly",
        globalThis: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Buffer: "readonly",
        Date: "readonly",
        JSON: "readonly",
        Promise: "readonly",
        Error: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off", // console.error is our only output channel
      "no-constant-condition": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // Exclude plugin (TypeScript, runs in Bun) and node_modules
    ignores: ["plugin/**", "node_modules/**"],
  },
];
