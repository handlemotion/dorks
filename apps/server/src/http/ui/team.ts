import { Effect, Schema } from "effect";
import { getDork } from "../../data";
import { setViewing, validClient } from "../../services/presence";
import { actorOf, meView, serverOrg } from "../../services/team";
import { ApiError, body, ok, service } from "../route";
import { handler, Loose, type Routes } from "./shared";

const Presence = Schema.Struct({ client: Loose, dorkId: Loose });

// ---- teams (services/team.ts, docs/cloud.md): who this request is, and where it is looking
export const teamRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/me",
    on((c) => service((a) => c.json({ ...meView(a, actorOf(c)), serverOrg: serverOrg(a) }))),
  );
  api.post(
    "/api/presence",
    on((c) =>
      Effect.gen(function* () {
        const b = yield* body(c, Presence);
        if (!validClient(b.client)) return yield* ApiError.of("invalid", "client must be 8 to 64 letters, digits, - or _");
        const dorkId = b.dorkId === null || b.dorkId === undefined ? null : b.dorkId;
        if (dorkId !== null && (typeof dorkId !== "string" || !getDork(app.db, dorkId))) return yield* ApiError.of("not_found", "not found");
        return yield* ok(c)(service((a) => setViewing(a, actorOf(c), b.client as string, dorkId as string | null)));
      }),
    ),
  );
};
