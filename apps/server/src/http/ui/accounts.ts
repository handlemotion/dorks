import { Effect, Schema } from "effect";
import { checkBoat } from "../../services/boatCheck";
import { finishAntigravitySignIn, startAntigravitySignIn } from "../../services/antigravitySignIn";
import { startBoatSignIn } from "../../services/boatSignIn";
import { finishCodexSignIn, signOutCodex, startCodexSignIn } from "../../services/codexSignIn";
import { githubRepos } from "../../services/githubRepos";
import { snapshotView, startBuild } from "../../services/snapshot";
import { getUsage } from "../../services/usage";
import { body, looseBody, serviceAsync } from "../route";
import { handler, type Routes } from "./shared";

const Force = Schema.Struct({ force: Schema.optional(Schema.Boolean) });
const Finish = Schema.Struct({ url: Schema.String });

// What the connected accounts report: Claude and Boat usage, the GitHub CLI's repositories, the Boat key and its base snapshot.
export const accountRoutes: Routes = (api, app) => {
  const on = handler(app);

  // ---- usage of the Claude subscription and Boat plan (services/usage.ts), cached for a minute
  api.get(
    "/api/usage",
    on((c) => serviceAsync(getUsage).pipe(Effect.map((u) => c.json(u)))),
  );

  // ---- what the GitHub CLI's login can see: its user, organizations and repositories (services/githubRepos.ts), cached briefly;
  // `?fresh=1` reads gh and GitHub again (after `gh auth refresh`, or granting the GitHub CLI access to an organization)
  api.get(
    "/api/github/repos",
    on((c) => serviceAsync((a) => githubRepos(a, { fresh: c.req.query("fresh") === "1" })).pipe(Effect.map((r) => c.json(r)))),
  );

  // ---- Boat key check (nothing is saved)
  api.post(
    "/api/boat/check",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => checkBoat(a, b))),
        Effect.map((r) => c.json(r)),
      ),
    ),
  );

  // ---- Boat sign-in with the Boat CLI (services/boatSignIn.ts): connects at once when the CLI is signed in, else returns the
  // browser link `boat login` printed; the key is saved when that sign-in finishes
  api.post(
    "/api/boat/sign-in",
    on((c) => serviceAsync(startBoatSignIn).pipe(Effect.map((v) => c.json({ boatSignIn: v })))),
  );

  // ---- Antigravity's Google sign-in, run by the agy CLI on this computer (services/antigravitySignIn.ts): returns Google's link;
  // the token is saved when the browser sign-in finishes. `finish` takes the address a browser on another computer ended on.
  api.post(
    "/api/antigravity/sign-in",
    on((c) => serviceAsync(startAntigravitySignIn).pipe(Effect.map((v) => c.json({ antigravitySignIn: v })))),
  );
  api.post(
    "/api/antigravity/sign-in/finish",
    on((c) =>
      body(c, Finish, "url must be a string").pipe(
        Effect.flatMap((b) => serviceAsync((a) => finishAntigravitySignIn(a, b.url))),
        Effect.map((v) => c.json({ antigravitySignIn: v })),
      ),
    ),
  );

  // ---- Codex's ChatGPT sign-in, run by the Codex CLI on this computer (services/codexSignIn.ts): returns OpenAI's link; Codex keeps
  // the sign-in in Dorks' own Codex home when the browser sign-in finishes. `finish` takes the address a browser on another computer
  // ended on; `DELETE` signs out.
  api.post(
    "/api/codex/sign-in",
    on((c) => serviceAsync(startCodexSignIn).pipe(Effect.map((v) => c.json({ codexSignIn: v })))),
  );
  api.post(
    "/api/codex/sign-in/finish",
    on((c) =>
      body(c, Finish, "url must be a string").pipe(
        Effect.flatMap((b) => serviceAsync((a) => finishCodexSignIn(a, b.url))),
        Effect.map((v) => c.json({ codexSignIn: v })),
      ),
    ),
  );
  api.delete(
    "/api/codex/sign-in",
    on((c) => serviceAsync(async (a) => signOutCodex(a)).pipe(Effect.map(() => c.json({})))),
  );

  // ---- base snapshot ("Prepare Boat")
  api.get(
    "/api/snapshot",
    on((c) => serviceAsync(snapshotView).pipe(Effect.map((v) => c.json(v)))),
  );
  api.post(
    "/api/snapshot/build",
    on((c) =>
      body(c, Force, "force must be a boolean").pipe(
        Effect.flatMap((b) => serviceAsync((a) => startBuild(a, { force: b.force === true }))),
        Effect.map((v) => c.json(v, 202)),
      ),
    ),
  );
};
