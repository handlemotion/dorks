import { Effect, Schema } from "effect";
import { getPullRequest, markPullRequestReady, mergePullRequest, updatePullRequestBranch } from "../../services/pullRequest";
import { body, ok, serviceAsync } from "../route";
import { handler, id, Loose, type Routes } from "./shared";

const Merge = Schema.Struct({ method: Loose, sha: Loose, url: Loose });
const Sha = Schema.Struct({ sha: Loose, url: Loose });
const Url = Schema.Struct({ url: Loose });

// ---- the session's pull requests, read live from GitHub; merged from Chat details. `url` picks one (default: the latest opened)
export const pullRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/dorks/:id/pr",
    on((c) =>
      serviceAsync((a) => getPullRequest(a, id(c), c.req.query("url"))).pipe(
        Effect.map((pr) => {
          c.header("Cache-Control", "no-store");
          return c.json(pr);
        }),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/pr/merge",
    on((c) =>
      body(c, Merge).pipe(
        Effect.flatMap((b) => serviceAsync((a) => mergePullRequest(a, id(c), b.method, b.sha, b.url))),
        Effect.map((r) => c.json(r)),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/pr/ready",
    on((c) =>
      body(c, Url).pipe(
        Effect.flatMap((b) => serviceAsync((a) => markPullRequestReady(a, id(c), b.url))),
        ok(c),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/pr/update-branch",
    on((c) =>
      body(c, Sha).pipe(
        Effect.flatMap((b) => serviceAsync((a) => updatePullRequestBranch(a, id(c), b.sha, b.url))),
        ok(c),
      ),
    ),
  );
};
