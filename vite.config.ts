import { defineConfig } from "vite-plus";

// Shared lint and format settings for the whole workspace (`vp check`, `vp lint`, `vp fmt` run from the root).
export default defineConfig({
  // `vp fmt` is set to the house style, but the codebase has never been run through it (it would still rewrite ~240 files), so `vp check`
  // skips formatting until that one-off reformat lands on its own.
  check: { fmt: false },
  fmt: {
    printWidth: 200,
    overrides: [{ files: ["apps/web/**"], options: { singleQuote: true, semi: false } }],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    // typeCheck stays off: each package type-checks itself with its own tsconfig (`pnpm typecheck`); one shared program mixes DOM, Bun and Workers globals.
    options: { typeAware: true },
  },
});
