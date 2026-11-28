import { expect, it } from "vite-plus/test";
import { planOf } from "./plans";

// The cloud's older plan names (free, collab, and the retired Dorks Cloud plan) must read as today's, or a team server would treat
// its members as on no plan.
it("reads the plan ids, and the cloud's older names as the new ones", () => {
  expect(["local", "teams", "Teams"].map(planOf)).toEqual(["local", "teams", "teams"]);
  expect([planOf("free"), planOf("collab"), planOf("cloud")]).toEqual(["local", "teams", "teams"]);
  expect([planOf("enterprise"), planOf(undefined), planOf(3)]).toEqual([null, null, null]);
});
