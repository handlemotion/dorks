import { searchFiles } from "../../services/files";
import { service } from "../route";
import { handler, id, type Routes } from "./shared";

// ---- the composer's `@` menu (services/files.ts, docs/architecture.md "Mentions")
export const fileRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/dorks/:id/files",
    on((c) => service((a) => c.json(searchFiles(a, id(c), c.req.query("q") ?? "", Number(c.req.query("limit")) || 50)))),
  );
};
