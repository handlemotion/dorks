import type { Context } from "hono";
import { Effect } from "effect";
import * as comments from "../../services/comments";
import { owned } from "../../services/dorks";
import { looseBody, service } from "../route";
import { handler, id, type Routes } from "./shared";
import { actorOf, byOfRequest, moderates } from "../../services/team";

// ---- preview comments (services/comments.ts, docs/architecture.md "Preview comments")
export const commentRoutes: Routes = (api, app) => {
  const on = handler(app);
  const cid = (c: Context) => c.req.param("cid") as string;
  api.get(
    "/api/dorks/:id/comments",
    on((c) =>
      service((a) => {
        owned(a, id(c));
        return c.json(comments.listComments(a, id(c)));
      }),
    ),
  );
  api.post(
    "/api/dorks/:id/comments",
    on((c) => looseBody(c).pipe(Effect.flatMap((b) => service((a) => c.json(comments.addComment(a, id(c), { body: b.body, anchor: b.anchor, port: b.port }, byOfRequest(c, a))))))),
  );
  api.post(
    "/api/dorks/:id/comments/:cid/replies",
    on((c) => looseBody(c).pipe(Effect.flatMap((b) => service((a) => c.json(comments.replyComment(a, id(c), cid(c), b.body, "owner", byOfRequest(c, a))))))),
  );
  api.patch(
    "/api/dorks/:id/comments/:cid",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) =>
          service((a) => {
            comments.changeComment(a, id(c), cid(c), { body: b.body, resolved: b.resolved }, "owner", byOfRequest(c, a));
            return c.json({});
          }),
        ),
      ),
    ),
  );
  api.delete(
    "/api/dorks/:id/comments/:cid",
    on((c) =>
      service((a) => {
        comments.deleteComment(a, id(c), cid(c), byOfRequest(c, a), moderates(actorOf(c)));
        return c.json({});
      }),
    ),
  );
};
