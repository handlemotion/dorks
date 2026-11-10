// Runs the mock UI server: `pnpm --filter @dorks/client mock` (Node 24 runs the TypeScript directly).
// Env: MOCK_PORT (default 4747), MOCK_TOKEN (default "mock-owner-token"), MOCK_CONFIGURED=1 to skip onboarding, MOCK_TICK ms.
import { startMockServer } from "./mock-server.ts";

const server = await startMockServer({
  port: Number(process.env.MOCK_PORT ?? 4747),
  token: process.env.MOCK_TOKEN ?? "mock-owner-token",
  configured: process.env.MOCK_CONFIGURED === "1",
  tick: process.env.MOCK_TICK ? Number(process.env.MOCK_TICK) : undefined,
});
// One JSON line, the same shape as the real server's ready line, so a supervisor can read either.
console.log(JSON.stringify({ ready: true, ui: server.url, mock: true }));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
