import { Effect, Schema } from "effect";
import { cloudAccount } from "../../services/cloudAccount";
import { body, ok, serviceAsync } from "../route";
import { handler, type Routes } from "./shared";

const Email = Schema.Struct({ email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)) });
const OrgName = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)) });
const Verify = Schema.Struct({ email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)), code: Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(12)) });

// ---- the Dorks Cloud account (services/cloudAccount.ts, docs/mobile.md "Desktop: Dorks Cloud"): sign this server in, list the
// account's places, and reach another server through the relay.
export const cloudRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/cloud",
    on((c) => serviceAsync((a) => cloudAccount.view(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.post(
    "/api/cloud/sign-in/email",
    on((c) => ok(c)(body(c, Email, "Enter your email").pipe(Effect.flatMap((b) => serviceAsync((a) => cloudAccount.sendCode(a, b.email.trim())))))),
  );
  api.post(
    "/api/cloud/sign-in/verify",
    on((c) =>
      body(c, Verify, "Enter the code from the email").pipe(
        Effect.flatMap((b) => serviceAsync((a) => cloudAccount.verifyCode(a, b.email.trim(), b.code.replace(/\s+/g, "")))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.delete(
    "/api/cloud/session",
    on((c) => ok(c)(serviceAsync((a) => cloudAccount.signOut(a)))),
  );
  api.get(
    "/api/cloud/places",
    on((c) => serviceAsync((a) => cloudAccount.places(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.post(
    "/api/cloud/orgs",
    on((c) =>
      body(c, OrgName, "Name the organization").pipe(
        Effect.flatMap((b) => serviceAsync((a) => cloudAccount.createOrg(a, b.name.trim()))),
        Effect.map((o) => c.json(o)),
      ),
    ),
  );
  // Another server's UI API, through the relay with the stored session (owner token required, like every /api route).
  api.all(
    "/api/cloud/servers/:id/*",
    on((c) => {
      const prefix = `/api/cloud/servers/${c.req.param("id")}/`;
      return serviceAsync((a) => cloudAccount.forward(a, c.req.param("id") as string, c.req.path.slice(prefix.length), c.req.raw));
    }),
  );
  // Its shared images, outside /api like this server's own `/images/:id`: an <img> cannot send the owner token, and the
  // 128-bit image id is the capability. Only image reads are forwarded this way.
  api.get(
    "/cloud/servers/:id/images/:image",
    on((c) => serviceAsync((a) => cloudAccount.forward(a, c.req.param("id") as string, `api/images/${c.req.param("image")}`, c.req.raw))),
  );
};
