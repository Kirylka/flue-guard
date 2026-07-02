import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "docs/.vitepress/dist/", "docs/.vitepress/cache/", ".samples-check/"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    // toolkit.ts is the generic composition root: TrustedSource and the
    // pipeline's internal plumbing genuinely take `any` (args flow through
    // caller-typed generics), and per-line disables would litter the file.
    // Public signatures stay precisely typed; keep `any` out of other files.
    files: ["src/toolkit.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
