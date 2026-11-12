import { defineConfig } from "vite-plus";

// testTimeout: the machine fuzz test runs 3000 sequences and exceeds the 5 s default when other packages' suites run in parallel.
// clearMocks: Vitest 5 (bundled with Vite+) clears mocks between tests by default; keep Vitest 4's behaviour until the tests are checked without it.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000, clearMocks: false },
});
