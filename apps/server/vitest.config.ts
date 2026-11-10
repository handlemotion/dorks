import { defineConfig } from "vitest/config";

// testTimeout: the machine fuzz test runs 3000 sequences and exceeds the 5 s default when other packages' suites run in parallel.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
