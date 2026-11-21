import type { Context } from "hono";
import { Effect, Schema } from "effect";
import { getDorkView, owned } from "../../services/dorks";
import * as subs from "../../services/subscriptions";
import { body, ok, service } from "../route";
import { handler, id, type Routes } from "./shared";

const Pr = Schema.Struct({ repo: Schema.String, number: Schema.Int });

// ---- PR subscriptions
export const subscriptionRoutes: Routes = (api, app) => {
  const on = handler(app);
  const pr = (c: Context) => body(c, Pr, "repo and number are required");
  api.get(
    "/api/dorks/:id/subscriptions",
    // Merged and closed ones too (they stay in the session's list); the agent's bridge sees only live ones.
    on((c) => service((a) => c.json(getDorkView(a, id(c)) ? subs.sessionSubscriptionViews(a, id(c)) : []))),
  );
  api.post(
    "/api/dorks/:id/subscriptions",
    on((c) =>
      pr(c).pipe(
        Effect.flatMap(({ repo, number }) => service((a) => a.db.tx(() => void subs.subscribe(a, owned(a, id(c)), repo, number, "user")))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/dorks/:id/subscriptions",
    on((c) =>
      pr(c).pipe(
        Effect.flatMap(({ repo, number }) =>
          service((a) =>
            a.db.tx(() => {
              owned(a, id(c));
              subs.unsubscribe(a, id(c), repo, number);
            }),
          ),
        ),
        ok(c),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/subscriptions/resume",
    on((c) =>
      pr(c).pipe(
        Effect.flatMap(({ repo, number }) => service((a) => a.db.tx(() => subs.resume(a, owned(a, id(c)), repo, number)))),
        ok(c),
      ),
    ),
  );
};
