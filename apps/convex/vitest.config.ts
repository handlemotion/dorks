import { defineConfig } from "vitest/config";

// The lifecycle machine is pure and carried over unchanged, so its existing suite runs as-is (plain node, no workerd).
export default defineConfig({
  test: {
    include: ["../api/test/machine.test.ts", "../api/test/normalize.test.ts", "../api/test/crypto.test.ts", "../api/test/github.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
