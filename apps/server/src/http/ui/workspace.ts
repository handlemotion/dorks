import { Effect, Schema } from "effect";
import { readWorkspaceFile, workspaceRoots, workspaceTree, writeWorkspaceFile } from "../../services/workspace";
import { body, serviceAsync } from "../route";
import { drive, handler, id, Loose, type Routes } from "./shared";

const Write = Schema.Struct({ root: Loose, path: Loose, contents: Loose, sha: Loose });

// ---- the Files tab: the sandbox's checkouts, read and saved through its bridge (services/workspace.ts)
export const workspaceRoutes: Routes = (api, app) => {
  const on = handler(app);
  const json = (c: Parameters<Parameters<typeof on>[0]>[0]) => (v: unknown) => {
    c.header("Cache-Control", "no-store");
    return c.json(v as object);
  };
  api.get(
    "/api/dorks/:id/workspace",
    on((c) => serviceAsync((a) => workspaceRoots(a, id(c))).pipe(Effect.map(json(c)))),
  );
  api.get(
    "/api/dorks/:id/workspace/tree",
    on((c) => serviceAsync((a) => workspaceTree(a, id(c), c.req.query("root"))).pipe(Effect.map(json(c)))),
  );
  api.get(
    "/api/dorks/:id/workspace/file",
    on((c) => serviceAsync((a) => readWorkspaceFile(a, id(c), c.req.query("root"), c.req.query("path"))).pipe(Effect.map(json(c)))),
  );
  api.put(
    "/api/dorks/:id/workspace/file",
    on((c) =>
      body(c, Write).pipe(
        Effect.tap(() => drive(c)),
        Effect.flatMap((b) => serviceAsync((a) => writeWorkspaceFile(a, id(c), b.root, b.path, b.contents, b.sha))),
        Effect.map(json(c)),
      ),
    ),
  );
};
