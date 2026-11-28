// Runs the mock UI server: `pnpm --filter @dorks/client mock` (Node 24 runs the TypeScript directly).
// Env: MOCK_PORT (default 4747), MOCK_TOKEN (default "mock-owner-token"), MOCK_CONFIGURED=1 to skip onboarding, MOCK_TICK ms, MOCK_CLOUD=1 to start signed in to the fake Dorks Cloud, MOCK_BOAT_OAUTH=1 for a Teams org's Sign in with Boat,
// MOCK_CLOUD_PLAN=paid|warn|used_up|trial|trial_used for the fake Cloud org's hours,
// MOCK_ORG_RUNTIME='{"url","token","orgId"}' to list a team the Worker runs, live from real s2 (mock-cloud.ts).
import { startMockServer } from "./mock-server.ts";
import type { MockCloudPlan } from "./mock-cloud.ts";

const server = await startMockServer({
  port: Number(process.env.MOCK_PORT ?? 4747),
  token: process.env.MOCK_TOKEN ?? "mock-owner-token",
  configured: process.env.MOCK_CONFIGURED === "1",
  tick: process.env.MOCK_TICK ? Number(process.env.MOCK_TICK) : undefined,
  cloudSignedIn: process.env.MOCK_CLOUD === "1",
  boatOAuth: process.env.MOCK_BOAT_OAUTH === "1",
  cloudPlan: process.env.MOCK_CLOUD_PLAN as MockCloudPlan | undefined,
  orgRuntime: process.env.MOCK_ORG_RUNTIME ? JSON.parse(process.env.MOCK_ORG_RUNTIME) : undefined,
});
// One JSON line, the same shape as the real server's ready line, so a supervisor can read either.
console.log(JSON.stringify({ ready: true, ui: server.url, mock: true }));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
