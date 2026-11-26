import { expect, it } from "vite-plus/test";
import { planOf } from "./plans";

// The cloud is moving from free/collab to local/teams/cloud: both must read the same until it has, or a team server would treat its
// members as on no plan.
it("reads the plan ids, and the cloud's older names as the new ones", () => {
  expect(["local", "teams", "cloud", "Teams"].map(planOf)).toEqual(["local", "teams", "cloud", "teams"]);
  expect([planOf("free"), planOf("collab")]).toEqual(["local", "teams"]);
  expect([planOf("enterprise"), planOf(undefined), planOf(3)]).toEqual([null, null, null]);
});
