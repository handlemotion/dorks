import { Effect, Schema } from "effect";
import { cloudAccount, cloudProfile, MAX_PICTURE_BYTES } from "../../services/cloudAccount";
import { body, looseBody, ok, service, serviceAsync } from "../route";
import { buildExportFile, moveStatus, startMove } from "../../services/cloudMove";
import { actorOf } from "../../services/team";
import { fail } from "../../app";
import { importKey } from "@dorks/shared";
import { z } from "zod";
import type { Context } from "hono";
import { handler, type Routes } from "./shared";

const OrgId = Schema.Struct({ orgId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)) });
const exportRequest = z.object({ orgId: z.string().min(1).max(128).optional(), importId: z.string().min(1).max(128), key: importKey });
const OrgName = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)) });
const Token = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(256), Schema.isPattern(/^[\w-]+$/));
const Handoff = Schema.Struct({ code: Token, state: Token });
const UserName = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)) });

/** A picture upload's raw bytes and type; too large is refused before it is read. */
const pictureBody = (c: Context) =>
  Effect.gen(function* () {
    if (Number(c.req.header("content-length") ?? 0) > MAX_PICTURE_BYTES) return yield* service(() => fail("invalid", "Pictures can be at most 2 MB"));
    const bytes = new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer()));
    return { bytes, type: (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase() };
  });

// ---- the Dorks Cloud account (services/cloudAccount.ts, docs/mobile.md "Desktop: Dorks Cloud"): sign this server in, list the
// account's places, and reach another server through the relay.
export const cloudRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/cloud",
    on((c) => serviceAsync((a) => cloudAccount.view(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  // Sign-in happens in the browser: this opens it (the site's URL with a one-time state), the `dorks://auth` link finishes it.
  api.post(
    "/api/cloud/sign-in",
    on((c) => service((a) => cloudAccount.startSignIn(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.post(
    "/api/cloud/sign-in/finish",
    on((c) =>
      body(c, Handoff, "Open the sign-in link from the browser again").pipe(
        Effect.flatMap((b) => serviceAsync((a) => cloudAccount.finishSignIn(a, b.code, b.state))),
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
  // Settings › Account: the profile (name, picture) and the account's sessions, edited in the app (services/cloudAccount.ts cloudProfile).
  api.get(
    "/api/cloud/account",
    on((c) => serviceAsync((a) => cloudProfile.view(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.patch(
    "/api/cloud/account",
    on((c) =>
      body(c, UserName, "Enter a name").pipe(
        Effect.flatMap((b) => serviceAsync((a) => cloudProfile.rename(a, b.name.trim()))),
        Effect.map((u) => c.json(u)),
      ),
    ),
  );
  api.put(
    "/api/cloud/account/avatar",
    on((c) =>
      pictureBody(c).pipe(
        Effect.flatMap((p) => serviceAsync((a) => cloudProfile.setAvatar(a, p.bytes, p.type))),
        Effect.map((u) => c.json(u)),
      ),
    ),
  );
  api.delete(
    "/api/cloud/account/avatar",
    on((c) => serviceAsync((a) => cloudProfile.removeAvatar(a)).pipe(Effect.map((u) => c.json(u)))),
  );
  api.delete(
    "/api/cloud/account/sessions",
    on((c) => serviceAsync((a) => cloudProfile.signOutOthers(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.delete(
    "/api/cloud/account/sessions/:id",
    on((c) => ok(c)(serviceAsync((a) => cloudProfile.signOutSession(a, c.req.param("id") as string)))),
  );
  // Settings › Organization: the org's logo, uploaded (owners and admins). Before the org forwarding below.
  api.put(
    "/api/cloud/orgs/:id/logo",
    on((c) =>
      pictureBody(c).pipe(
        Effect.flatMap((p) => serviceAsync((a) => cloudProfile.setOrgLogo(a, c.req.param("id") as string, p.bytes, p.type))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.delete(
    "/api/cloud/orgs/:id/logo",
    on((c) => serviceAsync((a) => cloudProfile.setOrgLogo(a, c.req.param("id") as string, null)).pipe(Effect.map((v) => c.json(v)))),
  );
  // Team management: Better Auth's organization endpoints as the signed-in account (an allowlist in services/cloudAccount.ts).
  api.on(
    ["GET", "POST"],
    "/api/cloud/auth/organization/:action",
    on((c) =>
      Effect.gen(function* () {
        const method = c.req.method.toUpperCase();
        const b = method === "POST" ? yield* looseBody(c) : undefined;
        const search = new URL(c.req.url).search;
        const out = yield* serviceAsync((a) => cloudAccount.orgAction(a, c.req.param("action") as string, method, search, b));
        return c.json(out as object);
      }),
    ),
  );
  // Move to cloud (services/cloudMove.ts, docs/move-to-cloud.md): only this computer's owner, never a teammate through the relay; the
  // cloud then checks that their account is an owner or admin of the org.
  const localOwner = (c: Context) =>
    service((): void => {
      if (actorOf(c).kind === "member") fail("forbidden", "Only this computer's owner can move it to the cloud");
    });
  api.get(
    "/api/cloud/move",
    on((c) => service((a) => moveStatus(a)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.post(
    "/api/cloud/move",
    on((c) =>
      localOwner(c).pipe(
        Effect.flatMap(() => body(c, OrgId, "Choose the organization")),
        Effect.flatMap((b) => serviceAsync((a) => startMove(a, b.orgId))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.post(
    "/api/cloud/export",
    on((c) =>
      localOwner(c).pipe(
        Effect.flatMap(() => looseBody(c)),
        Effect.flatMap((b) => {
          const req = exportRequest.safeParse(b);
          return req.success ? serviceAsync((a) => buildExportFile(a, req.data)) : service(() => fail("invalid", "Send {importId, key} from the import endpoint"));
        }),
        Effect.map((f) => c.json(f)),
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
  // An org the Worker runs (Teams, Cloud): its UI API and the realtime routes that issue its s2 read tokens.
  api.all(
    "/api/cloud/orgs/:id/*",
    on((c) => {
      const prefix = `/api/cloud/orgs/${c.req.param("id")}/`;
      return serviceAsync((a) => cloudAccount.forwardOrg(a, c.req.param("id") as string, c.req.path.slice(prefix.length), c.req.raw));
    }),
  );
  // A Worker-run org's shared images, outside /api for the same reason as a server's below.
  api.get(
    "/cloud/orgs/:id/images/:image",
    on((c) => serviceAsync((a) => cloudAccount.forwardOrg(a, c.req.param("id") as string, `api/images/${c.req.param("image")}`, c.req.raw))),
  );
  // Its shared images, outside /api like this server's own `/images/:id`: an <img> cannot send the owner token, and the
  // 128-bit image id is the capability. Only image reads are forwarded this way.
  api.get(
    "/cloud/servers/:id/images/:image",
    on((c) => serviceAsync((a) => cloudAccount.forward(a, c.req.param("id") as string, `api/images/${c.req.param("image")}`, c.req.raw))),
  );
};
