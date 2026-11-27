import { searchFiles, searchRepoFiles } from "../../services/files";
import { actorOf } from "../../services/team";
import { service, serviceAsync } from "../route";
import { handler, id, type Routes } from "./shared";

// ---- the composer's `@` menu (services/files.ts, docs/architecture.md "Mentions")
export const fileRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/dorks/:id/files",
    on((c) => service((a) => c.json(searchFiles(a, id(c), c.req.query("q") ?? "", Number(c.req.query("limit")) || 50)))),
  );
  // A new session's: the repository it will start in. Only the owner at this computer reads its local clone.
  api.get(
    "/api/repo-files",
    on((c) => serviceAsync(async (a) => c.json(await searchRepoFiles(a, c.req.query("repo") ?? "", c.req.query("q") ?? "", Number(c.req.query("limit")) || 50, actorOf(c).kind === "local")))),
  );
};
