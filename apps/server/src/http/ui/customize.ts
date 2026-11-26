import { Effect } from "effect";
import { composioLink, composioStatus, composioUnlink, connectComposio, disconnectComposio } from "../../services/composio";
import { signOutMcp, startMcpSignIn } from "../../services/mcpOAuth";
import { deleteMcpServer, listMcpServers, putMcpServer } from "../../services/mcpServers";
import { addLocalSkills, deleteSkill, installSkills, listLocalSkills, listSkills, resolveSkills, updateSkill } from "../../services/skills";
import { looseBody, ok, service, serviceAsync } from "../route";
import { handler, name, type Routes } from "./shared";

// What the owner adds to every sandbox from Customize: MCP servers, skills and Composio apps.
export const customizeRoutes: Routes = (api, app) => {
  const on = handler(app);

  // ---- MCP servers from Customize (services/mcpServers.ts): views carry header and env names, never values
  api.get(
    "/api/mcp-servers",
    on((c) => service((a) => c.json(listMcpServers(a)))),
  );
  api.put(
    "/api/mcp-servers/:name",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => putMcpServer(a, name(c), b))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.delete(
    "/api/mcp-servers/:name",
    on((c) => ok(c)(service((a) => deleteMcpServer(a, name(c))))),
  );
  // OAuth sign-in for a remote server (services/mcpOAuth.ts): `base` is the URL the browser reaches this server at, for the callback
  api.post(
    "/api/mcp-servers/:name/oauth",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => startMcpSignIn(a, name(c), b.base))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.delete(
    "/api/mcp-servers/:name/oauth",
    on((c) => serviceAsync((a) => signOutMcp(a, name(c))).pipe(ok(c))),
  );

  // ---- Skills from Customize (services/skills.ts, docs/skills.md): installed once from GitHub, shared by every sandbox
  api.get(
    "/api/skills",
    on((c) => service((a) => c.json(listSkills(a)))),
  );
  api.post(
    "/api/skills/resolve",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => resolveSkills(a, b.source))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.post(
    "/api/skills",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => installSkills(a, b))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  // The skills already on this computer (~/.agents/skills, ~/.claude/skills): the local owner only, not a team (services/team.ts)
  api.get(
    "/api/skills/local",
    on((c) => service((a) => c.json(listLocalSkills(a)))),
  );
  api.post(
    "/api/skills/local",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => service((a) => addLocalSkills(a, b))),
        Effect.map((v) => c.json(v)),
      ),
    ),
  );
  api.post(
    "/api/skills/:name/update",
    on((c) => serviceAsync((a) => updateSkill(a, name(c))).pipe(Effect.map((v) => c.json(v)))),
  );
  api.delete(
    "/api/skills/:name",
    on((c) => ok(c)(service((a) => deleteSkill(a, name(c))))),
  );

  // ---- Composio (services/composio.ts): one key for the OAuth-only apps, each signed in to in a browser
  api.get(
    "/api/composio",
    on((c) => serviceAsync(composioStatus).pipe(Effect.map((v) => c.json(v)))),
  );
  api.put(
    "/api/composio",
    on((c) =>
      looseBody(c).pipe(
        Effect.flatMap((b) => serviceAsync((a) => connectComposio(a, b.apiKey))),
        ok(c),
      ),
    ),
  );
  api.delete(
    "/api/composio",
    on((c) => ok(c)(service(disconnectComposio))),
  );
  api.post(
    "/api/composio/toolkits/:toolkit/link",
    on((c) => serviceAsync((a) => composioLink(a, c.req.param("toolkit") as string)).pipe(Effect.map((v) => c.json(v)))),
  );
  api.delete(
    "/api/composio/toolkits/:toolkit",
    on((c) => serviceAsync((a) => composioUnlink(a, c.req.param("toolkit") as string)).pipe(ok(c))),
  );
};
