import { Effect, Schema } from "effect";
import { phoneLink } from "../../services/phoneLink";
import { body, ok, service, serviceAsync } from "../route";
import { handler, Loose, str, type Routes } from "./shared";

const PairBody = Schema.Struct({ name: Loose });

// ---- the phone link (services/phoneLink.ts, docs/mobile.md): pairing this Mac with the iPhone app through the cloud relay
export const phoneRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/phone",
    on((c) => service((a) => c.json(phoneLink(a).view()))),
  );
  api.post(
    "/api/phone/pair",
    on((c) =>
      body(c, PairBody).pipe(
        Effect.flatMap((b) => serviceAsync((a) => phoneLink(a).pair(typeof b.name === "string" ? str(b.name) : undefined))),
        Effect.map((p) => c.json(p)),
      ),
    ),
  );
  api.delete(
    "/api/phone/pair",
    on((c) => ok(c)(service((a) => phoneLink(a).cancelPair()))),
  );
  api.delete(
    "/api/phone",
    on((c) => ok(c)(serviceAsync((a) => phoneLink(a).unpair()))),
  );
};
