import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**", ".cache/**", ".pnpm-store/**"],
    plugins: ["typescript", "react"],
    categories: { correctness: "error", suspicious: "warn" },
    rules: { "react/react-in-jsx-scope": "off" }, // React's automatic JSX runtime needs no React binding.
  },
  fmt: {
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules/**",
      ".cache/**",
      ".pnpm-store/**",
      "pnpm-lock.yaml",
      ".agents/**",
      ".claude/**",
      ".cursor/**",
      ".recall/**",
      ".superpowers/**",
      ".e2e/**",
    ],
  },
});
