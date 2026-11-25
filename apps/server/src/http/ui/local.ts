import { Effect, Schema } from "effect";
import { owned } from "../../services/dorks";
import { answerInput } from "../../services/inputs";
import { decideLocal, localAccessView, revokeSessions, setLocalAccess } from "../../services/local";
import { body, ok, service, serviceAsync } from "../route";
import { handler, id, Loose, type Routes } from "./shared";

const LocalDecision = Schema.Struct({ decision: Loose });
const Enabled = Schema.Struct({ enabled: Loose });
const InputAnswer = Schema.Struct({ values: Loose, dismiss: Loose });

// ---- local access: the agent's requests to use this computer (services/local.ts, docs/local-access.md)
export const localRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.post(
    "/api/dorks/:id/local/:requestId",
    on((c) =>
      body(c, LocalDecision).pipe(
        Effect.flatMap((b) => service((a) => decideLocal(a, owned(a, id(c)).id, c.req.param("requestId") as string, b.decision))),
        ok(c),
      ),
    ),
  );
  // Secure inputs (services/inputs.ts, docs/secure-inputs.md): the owner fills in or dismisses an agent's request for values.
  api.post(
    "/api/dorks/:id/inputs/:requestId",
    on((c) =>
      body(c, InputAnswer).pipe(
        Effect.flatMap((b) => serviceAsync((a) => answerInput(a, owned(a, id(c)).id, c.req.param("requestId") as string, b))),
        ok(c),
      ),
    ),
  );
  api.get(
    "/api/local-access",
    on((c) => service((a) => c.json(localAccessView(a)))),
  );
  api.put(
    "/api/local-access",
    on((c) =>
      body(c, Enabled).pipe(
        Effect.flatMap((b) => service((a) => setLocalAccess(a, b.enabled))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/local-access/sessions",
    on((c) => ok(c)(service((a) => revokeSessions(a, c.req.query("dork") || undefined)))),
  );
};
