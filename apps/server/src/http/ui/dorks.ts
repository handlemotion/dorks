import { Effect, Schema } from "effect";
import { MAX_IMAGE_BYTES, uploadImage } from "../../services/bridge";
import {
  chooseCodexModel,
  createDork,
  desktopUrl,
  getDorkView,
  interrupt,
  listDorks,
  listEvents,
  markRead,
  queueMessage,
  removeDork,
  renameDork,
  sendMessage,
  setArchived,
  setMode,
  takeQueued,
} from "../../services/dorks";
import { chooseModel } from "../../services/models";
import { ApiError, body, intQuery, ok, service, serviceAsync } from "../route";
import { handler, id, Loose, str, type Routes } from "./shared";
import { byOfRequest } from "../../services/team";

const CreateDork = Schema.Struct({
  repo: Loose,
  message: Loose,
  title: Loose,
  provider: Loose,
  model: Loose,
  effort: Loose,
  fast: Loose,
  buildId: Loose,
  setup: Loose,
  mode: Loose,
  kind: Loose,
  icon: Loose,
});
const Mode = Schema.Struct({ mode: Loose });
const Text = Schema.Struct({ text: Loose });
const Title = Schema.Struct({ title: Loose });
const Theme = Schema.Struct({ theme: Loose });
const Archived = Schema.Struct({ archived: Schema.Boolean });
const ModelChoice = Schema.Struct({ model: Loose, effort: Loose, fast: Loose });

export const dorkRoutes: Routes = (api, app) => {
  const on = handler(app);

  // ---- images: an attachment for a message the owner is writing (raw bytes in the body). The message names it as dorks-image:<id>.
  api.post(
    "/api/images",
    on((c) =>
      Effect.gen(function* () {
        if (Number(c.req.header("content-length") ?? 0) > MAX_IMAGE_BYTES) return yield* ApiError.of("invalid", "the image is larger than 8 MB");
        const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
        return c.json(yield* service((a) => uploadImage(a, bytes)), 201);
      }),
    ),
  );

  // ---- dorks
  api.get(
    "/api/dorks",
    on((c) => service((a) => c.json(listDorks(a, c.req.query("archived") === "true")))),
  );
  api.post(
    "/api/dorks",
    on((c) =>
      Effect.gen(function* () {
        const b = yield* body(c, CreateDork);
        const dorkId = yield* service((a) =>
          createDork(a, {
            repo: b.repo as string | undefined,
            message: str(b.message),
            title: b.title as string | undefined,
            provider: b.provider as never,
            model: b.model,
            effort: b.effort,
            fast: b.fast,
            buildId: b.buildId,
            setup: b.setup,
            // `kind: "coordinator"` is the name a nerd had before modes (docs/modes.md).
            mode: b.mode ?? (b.kind === "coordinator" ? "nerd" : undefined),
            icon: b.icon,
            by: byOfRequest(c, a),
          }),
        );
        return c.json({ id: dorkId }, 201);
      }),
    ),
  );
  api.get(
    "/api/dorks/:id",
    on((c) => service((a) => getDorkView(a, id(c))).pipe(Effect.flatMap((d) => (d ? Effect.succeed(c.json(d)) : Effect.fail(ApiError.of("not_found", "not found")))))),
  );
  api.patch(
    "/api/dorks/:id",
    on((c) =>
      body(c, Title).pipe(
        Effect.flatMap((b) => service((a) => renameDork(a, id(c), str(b.title)))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/dorks/:id",
    on((c) => ok(c)(service((a) => removeDork(a, id(c))))),
  );
  api.post(
    "/api/dorks/:id/messages",
    on((c) =>
      body(c, Text).pipe(
        Effect.flatMap((b) => service((a) => sendMessage(a, id(c), str(b.text), undefined, byOfRequest(c, a)))),
        ok(c),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/queue",
    on((c) =>
      body(c, Text).pipe(
        Effect.flatMap((b) => service((a) => queueMessage(a, id(c), str(b.text), byOfRequest(c, a)))),
        Effect.map((r) => c.json(r)),
      ),
    ),
  );
  api.delete(
    "/api/dorks/:id/queue/:qid",
    on((c) => ok(c)(service((a) => takeQueued(a, id(c), c.req.param("qid") ?? "", false)))),
  );
  api.post(
    "/api/dorks/:id/queue/:qid/send",
    on((c) => ok(c)(service((a) => takeQueued(a, id(c), c.req.param("qid") ?? "", true)))),
  );
  api.post(
    "/api/dorks/:id/interrupt",
    on((c) => ok(c)(service((a) => interrupt(a, id(c))))),
  );
  api.post(
    "/api/dorks/:id/desktop",
    on((c) =>
      Effect.gen(function* () {
        const b = yield* body(c, Theme);
        const url = yield* serviceAsync((a) => desktopUrl(a, id(c), { theme: b.theme === "dark" ? "dark" : "light" }));
        c.header("Cache-Control", "no-store");
        return c.json({ url });
      }),
    ),
  );
  api.post(
    "/api/dorks/:id/read",
    on((c) => service((a) => markRead(a, id(c))).pipe(ok(c))),
  );
  api.post(
    "/api/dorks/:id/archive",
    on((c) =>
      body(c, Archived, "archived must be a boolean").pipe(
        Effect.flatMap((b) => service((a) => setArchived(a, id(c), b.archived))),
        ok(c),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/mode",
    on((c) =>
      body(c, Mode).pipe(
        Effect.flatMap((b) => service((a) => setMode(a, id(c), b.mode))),
        ok(c),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/model",
    on((c) =>
      body(c, ModelChoice).pipe(
        Effect.flatMap((b) => service((a) => chooseModel(a, id(c), b.model, b.effort, b.fast))),
        ok(c),
      ),
    ),
  );
  api.post(
    "/api/dorks/:id/codex-model",
    on((c) =>
      body(c, ModelChoice).pipe(
        Effect.flatMap((b) => service((a) => chooseCodexModel(a, id(c), str(b.model), str(b.effort)))),
        ok(c),
      ),
    ),
  );
  api.get(
    "/api/dorks/:id/events",
    on((c) =>
      Effect.gen(function* () {
        const q = { before: yield* intQuery(c, "before"), after: yield* intQuery(c, "after"), limit: yield* intQuery(c, "limit") };
        return c.json(yield* service((a) => listEvents(a, id(c), q)));
      }),
    ),
  );
};
