import { defineConfig } from "vite-plus";

// Shared lint and format settings for the whole workspace (`vp check`, `vp lint`, `vp fmt` run from the root).
export default defineConfig({
  // House style: 200 columns everywhere; Markdown (hand-wrapped prose) is left alone; the web app and @dorks/ui without semicolons (web also with single quotes).
  // The shadcn / AI Elements files in packages/ui are installed by the shadcn CLI and overwritten on every update, so they stay as published.
  fmt: {
    printWidth: 200,
    ignorePatterns: ["**/*.md", "packages/ui/src/components/ui/**", "packages/ui/src/components/ai-elements/**", "**/*.gen.ts", "**/.cloudflare/**", "**/dist/**"],
    overrides: [
      { files: ["apps/web/**"], options: { singleQuote: true, semi: false } },
      { files: ["packages/ui/**"], options: { semi: false } },
    ],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    // complexity (max 20) is an error: split branchy code into named helpers or handler maps rather than disabling it.
    rules: { complexity: "error", "vite-plus/prefer-vite-plus-imports": "error" },
    ignorePatterns: ["**/dist/**", "**/node_modules/**", "**/*.gen.ts", "**/.cloudflare/**"],
    // typeCheck stays off: each package type-checks itself with its own tsconfig (`pnpm typecheck`); one shared program mixes DOM, Bun and Workers globals.
    options: { typeAware: true },
  },
});
