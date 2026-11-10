// Runs the web app against the in-memory mock server (no real dorks-server needed): `pnpm --filter @dorks/web dev:mock`.
// Opens http://localhost:3000/?server=http://127.0.0.1:4747&token=mock-owner-token once; the page stores it.
// MOCK_CONFIGURED=1 skips the first-run setup.
import { spawn } from "node:child_process";

const env = { ...process.env, MOCK_PORT: process.env.MOCK_PORT ?? "4747", MOCK_TOKEN: process.env.MOCK_TOKEN ?? "mock-owner-token" };
const mock = spawn("node", ["../../packages/client/src/mock-cli.ts"], { stdio: "inherit", env });
const vite = spawn("pnpm", ["exec", "vite", "--port", "3000"], { stdio: "inherit", env });
console.log(`\nMock server on http://127.0.0.1:${env.MOCK_PORT}. Open:\n  http://localhost:3000/?server=http://127.0.0.1:${env.MOCK_PORT}&token=${env.MOCK_TOKEN}\n`);

const stop = () => {
  mock.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of [mock, vite]) child.on("exit", () => (stop(), process.exit(0)));
