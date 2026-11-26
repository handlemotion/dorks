import { Effect, Schema } from "effect";
import { assertBoatAccepts, assertCodexEnvironment } from "../../services/boatCheck";
import { forgetGithubRepos } from "../../services/githubRepos";
import { autoConnectBoat } from "../../services/boatSignIn";
import { refreshAntigravityModels } from "../../services/models";
import { autoConnectGithub, deleteSecret, secretNames, setSecret, settingsView, updateSettings } from "../../services/settings";
import { buildIfMissing } from "../../services/snapshot";
import { forgetUsage } from "../../services/usage";
import { kickSentryWatch } from "../../services/automations";
import { actorOf } from "../../services/team";
import { localAvailabilityOf } from "../../services/localDorks";
import { fail } from "../../app";
import { body, looseBody, ok, service, serviceAsync } from "../route";
import { handler, Loose, name, str, type Routes } from "./shared";

const SecretValue = Schema.Struct({ value: Loose });

// ---- settings and secrets
export const settingsRoutes: Routes = (api, app) => {
  const on = handler(app);
  api.get(
    "/api/settings",
    on((c) =>
      service((a) => {
        // Boat and GitHub connect by themselves when their CLIs are signed in (in the background: the answer never waits for them).
        void autoConnectBoat(a);
        void autoConnectGithub(a);
        void refreshAntigravityModels(a); // Antigravity's models for a new session's menu, with the saved sign-in
        return c.json(settingsView(a, localAvailabilityOf(c, a)));
      }),
    ),
  );
  api.put(
    "/api/settings",
    on((c) =>
      Effect.gen(function* () {
        const patch = yield* looseBody(c);
        // Always allow runs commands on this computer: local access stays with the local owner, whatever a teammate's role (docs/cloud.md).
        if (actorOf(c).kind === "member" && "localAlwaysAllow" in patch) yield* service(() => fail("forbidden", "Only this computer's owner can let sessions use it without asking"));
        if (actorOf(c).kind !== "local" && "defaultLocation" in patch) yield* service(() => fail("forbidden", "Only this computer's owner can choose where its sessions run"));
        // Provider values are checked here, by the server, before anything is saved (GitHub's is checked inside updateSettings).
        yield* serviceAsync((a) => assertBoatAccepts(a, patch));
        yield* serviceAsync((a) => assertCodexEnvironment(a, patch));
        yield* serviceAsync((a) => updateSettings(a, patch));
        yield* service((a) => {
          if ("claudeToken" in patch || "antigravityToken" in patch || "boatKey" in patch || "boatOrg" in patch) forgetUsage(a);
          if ("githubConnected" in patch) forgetGithubRepos(a);
          if ("sentryToken" in patch || "sentryOrg" in patch || "sentryUrl" in patch) kickSentryWatch(a);
          console.error(`settings saved: ${Object.keys(patch).sort().join(", ")}`); // names only, never values
          // A new Boat key starts the base-snapshot build in the background (onboarding has no "Prepare Boat" step), or retries a failed one.
          if (typeof patch.boatKey === "string" && patch.boatKey.trim()) buildIfMissing(a, { retryFailed: true });
        });
        return c.json({});
      }),
    ),
  );
  api.get(
    "/api/secrets",
    on((c) => service((a) => c.json(secretNames(a)))),
  );
  api.put(
    "/api/secrets/:name",
    on((c) =>
      body(c, SecretValue).pipe(
        Effect.flatMap((b) => serviceAsync((a) => setSecret(a, name(c), str(b.value)))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/secrets/:name",
    on((c) => ok(c)(service((a) => deleteSecret(a, name(c))))),
  );
};
