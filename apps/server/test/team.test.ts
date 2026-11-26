import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import { serveRelayed } from "../src/services/phoneLink";
import { openStream, setViewing, viewersOf } from "../src/services/presence";
import { teamAllowed } from "../src/services/team";
import { fakeFetch, harness, NOW } from "./harness";

// Teams (docs/cloud.md): relayed requests carry the cloud's identity token; this server checks it against the cloud's JWKS and its
// own organization, lets each role do what it may, and says who sent each message, to the transcript and to the agent.

const CLOUD = "https://cloud.test";
const ORG = "org_team";

async function keypair(kid: string) {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", k.publicKey)) as { x?: string };
  const sign = async (claims: object) => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc({ alg: "EdDSA", kid, typ: "JWT" })}.${enc(claims)}`;
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg: "EdDSA" }, sign };
}

type Sent = { t: string; status?: number; data?: string };

async function setup() {
  const keys = [await keypair("k1")];
  const fetch = fakeFetch((url) => (url.pathname === "/api/auth/jwks" ? Response.json({ keys: keys.map((k) => k.jwk) }) : new Response("{}", { status: 404 })));
  const h = harness({ fetch, config: { cloudUrl: CLOUD } });
  const ui = uiApp(h.app);
  const exp = Math.floor(NOW / 1000) + 600;
  const token = (o: object = {}, k = keys[0]) => k.sign({ sub: "u_ada", name: "Ada", email: "ada@team.test", org: ORG, role: "member", plan: "collab", iss: CLOUD, aud: CLOUD, exp, ...o });
  const relay = async (method: string, path: string, actor?: string, body?: object) => {
    const sent: Sent[] = [];
    const headers: Record<string, string> = { "content-type": "application/json", ...(actor ? { "x-dorks-actor": actor } : {}) };
    const f = { t: "req" as const, id: "1", method, path, headers, ...(body ? { body: Buffer.from(JSON.stringify(body)).toString("base64") } : {}) };
    await serveRelayed(
      h.app,
      (r) => ui.fetch(r),
      f,
      (o) => void sent.push(o as Sent),
      new AbortController().signal,
    );
    const text = sent
      .filter((s) => s.t === "chunk")
      .map((s) => Buffer.from(s.data!, "base64").toString())
      .join("");
    return { status: sent.find((s) => s.t === "head")!.status, body: text ? JSON.parse(text) : null };
  };
  const setOrg = (org: string | null) => h.app.db.run("UPDATE settings SET cloud_org_id = ? WHERE id = 1", org);
  return { h, keys, fetch, token, relay, setOrg, exp };
}

describe("team identity on the relay", () => {
  it("attributes a teammate's message and tells the agent who sent it", async () => {
    const { h, token, relay, setOrg } = await setup();
    setOrg(ORG);
    const id = h.seed("idle");
    expect((await relay("POST", `/api/dorks/${id}/messages`, await token(), { text: "fix the login" })).status).toBe(200);
    const msg = h.events(id).find((e) => e.body.type === "user_message")!.body;
    expect(msg).toMatchObject({ text: "fix the login", by: { id: "u_ada", name: "Ada" } });
    expect(h.cmds(id).find((c) => c.kind === "user_message")!.text).toBe("[Message from Ada (ada@team.test)]\n\nfix the login");
    expect((await relay("GET", "/api/me", await token())).body).toMatchObject({ kind: "member", id: "u_ada", role: "member", serverOrg: ORG });
  });

  it("names the local owner as the cloud does, and tells the agent only once the chat is shared", async () => {
    const { h, token, relay, setOrg } = await setup();
    setOrg(ORG);
    h.app.db.run("UPDATE settings SET cloud_owner = ? WHERE id = 1", JSON.stringify({ id: "u_owner", name: "Olive", email: "olive@team.test" }));
    const ui = uiApp(h.app);
    const local = (text: string) =>
      ui.fetch(
        new Request(`http://127.0.0.1/api/dorks/${id}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${h.app.cfg.ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      );
    const id = h.seed("idle");
    expect((await local("solo")).status).toBe(200);
    expect((await relay("POST", `/api/dorks/${id}/messages`, await token(), { text: "hi from Ada" })).status).toBe(200);
    expect((await local("now shared")).status).toBe(200);
    const users = h
      .events(id)
      .filter((e) => e.body.type === "user_message")
      .map((e) => e.body as { text: string; by?: { id: string } });
    expect(users.map((u) => u.by?.id)).toEqual(["u_owner", "u_ada", "u_owner"]);
    const texts = h.app.db.all<{ text: string }>("SELECT text FROM commands WHERE dork_id = ? AND kind = 'user_message' ORDER BY id", id).map((r) => r.text);
    expect(texts).toEqual(["solo", "[Message from Ada (ada@team.test)]\n\nhi from Ada", "[Message from Olive (olive@team.test)]\n\nnow shared"]);
  });

  it("keeps each person's preview comments theirs to edit and delete", async () => {
    const { h, token, relay, setOrg } = await setup();
    setOrg(ORG);
    const id = h.seed("idle");
    const anchor = { kind: "element", path: "/", selector: "main", label: "main" };
    const ada = await token();
    const grace = await token({ sub: "u_grace", name: "Grace" });
    const mine = (await relay("POST", `/api/dorks/${id}/comments`, ada, { body: "Bluer", anchor, port: 5173 })).body.id as string;
    expect((await relay("PATCH", `/api/dorks/${id}/comments/${mine}`, grace, { body: "Greener" })).body.error.code).toBe("forbidden");
    expect((await relay("DELETE", `/api/dorks/${id}/comments/${mine}`, grace)).body.error.code).toBe("forbidden");
    expect((await relay("PATCH", `/api/dorks/${id}/comments/${mine}`, ada, { body: "Bluest" })).status).toBe(200);
    // The local owner's comment (no writer) is not a teammate's either.
    const ui = uiApp(h.app);
    const own = (await (
      await ui.fetch(
        new Request(`http://127.0.0.1/api/dorks/${id}/comments`, {
          method: "POST",
          headers: { authorization: `Bearer ${h.app.cfg.ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ body: "Mine", anchor, port: 5173 }),
        }),
      )
    ).json()) as { id: string };
    expect((await relay("DELETE", `/api/dorks/${id}/comments/${own.id}`, ada)).body.error.code).toBe("forbidden");
    const list = (await relay("GET", `/api/dorks/${id}/comments`, ada)).body as { body: string; by?: { name: string } }[];
    expect(list.map((c) => [c.body, c.by?.name])).toEqual([
      ["Bluest", "Ada"],
      ["Mine", undefined],
    ]);
  });

  it("lets admins and the owner delete anyone's comment, but only its author edit it", async () => {
    const { h, token, relay, setOrg } = await setup();
    setOrg(ORG);
    const id = h.seed("idle");
    const anchor = { kind: "element", path: "/", selector: "main", label: "main" };
    const ada = await token();
    const admin = await token({ sub: "u_grace", name: "Grace", role: "admin" });
    const add = async (body: string) => (await relay("POST", `/api/dorks/${id}/comments`, ada, { body, anchor, port: 5173 })).body.id as string;
    const first = await add("One");
    const second = await add("Two");
    expect((await relay("PATCH", `/api/dorks/${id}/comments/${first}`, admin, { body: "Edited" })).body.error.code).toBe("forbidden");
    expect((await relay("DELETE", `/api/dorks/${id}/comments/${first}`, admin)).status).toBe(200);
    // The local owner moderates too.
    const owner = (method: string, body?: object) =>
      uiApp(h.app).fetch(
        new Request(`http://127.0.0.1/api/dorks/${id}/comments/${second}`, {
          method,
          headers: { authorization: `Bearer ${h.app.cfg.ownerToken}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    expect(((await (await owner("PATCH", { body: "Edited" })).json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect((await owner("DELETE")).status).toBe(200);
    expect((await relay("GET", `/api/dorks/${id}/comments`, ada)).body).toEqual([]);
  });

  it("checks the signature, expiry and organization, and the role", async () => {
    const { token, relay, setOrg, exp } = await setup();
    const stranger = await keypair("k1"); // same key id, another key: a forged token
    setOrg(ORG);
    expect((await relay("GET", "/api/dorks", await token({}, stranger))).status).toBe(403);
    expect((await relay("GET", "/api/dorks", await token({ exp: exp - 3600 }))).status).toBe(403);
    expect((await relay("GET", "/api/dorks", await token({ aud: "https://elsewhere.test" }))).status).toBe(403);
    expect((await relay("GET", "/api/dorks", await token({ iss: "https://elsewhere.test" }))).status).toBe(403);
    expect((await relay("GET", "/api/dorks", await token({ org: "org_other" }))).body.error.message).toMatch(/another team/);
    expect((await relay("GET", "/api/dorks", await token())).status).toBe(200);
    // Roles: a member uses dorks; settings, secret names and automations are for admins.
    expect((await relay("GET", "/api/secrets", await token())).status).toBe(403);
    expect((await relay("PUT", "/api/settings", await token(), { sleepMinutes: 9 })).status).toBe(403);
    expect((await relay("GET", "/api/secrets", await token({ role: "admin" }))).status).toBe(200);
    expect((await relay("GET", "/api/secrets", await token({ role: "member,admin" }))).status).toBe(200);
    // Without a token: refused once this server belongs to an organization, today's phone before that.
    expect((await relay("GET", "/api/dorks")).status).toBe(403);
    setOrg(null);
    expect((await relay("GET", "/api/dorks")).status).toBe(200);
    expect((await relay("GET", "/api/dorks", await token())).status).toBe(403); // a token, but no org to check it against
  });

  it("picks up a rotated signing key", async () => {
    const { h, keys, fetch, token, relay, setOrg } = await setup();
    setOrg(ORG);
    expect((await relay("GET", "/api/dorks", await token())).status).toBe(200);
    keys.unshift(await keypair("k2"));
    const t2 = await token({}, keys[0]);
    // A key id the cache has not seen makes it fetch the keys again, at most every 30 s.
    const jwksCalls = () => fetch.calls.filter((c) => c.url === "/api/auth/jwks").length;
    expect((await relay("GET", "/api/dorks", t2)).status).toBe(403);
    expect(jwksCalls()).toBe(1);
    h.clock.t += 31_000;
    expect((await relay("GET", "/api/dorks", t2)).status).toBe(200);
    expect(jwksCalls()).toBe(2);
  });

  it("never lets any role reach local access, secret values or the box's screen", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      for (const [m, p] of [
        ["POST", "/api/dorks/d1/local/r1"],
        ["POST", "/api/dorks/d1/inputs/r1"],
        ["POST", "/api/dorks/d1/desktop"],
        ["PUT", "/api/mcp-servers/x"],
        ["PUT", "/api/local-access"],
        ["POST", "/api/phone/pair"],
        ["POST", "/api/dorks/d1/%2e%2e/%2e%2e/settings"],
        ["POST", "/mcp"],
      ])
        expect(teamAllowed(role, m!, p!), `${role} ${m} ${p}`).toBe(false);
    }
    expect(teamAllowed("member", "POST", "/api/automations")).toBe(false);
    expect(teamAllowed("admin", "POST", "/api/automations")).toBe(true);
    expect(teamAllowed("member", "POST", "/api/dorks/d1/messages")).toBe(true);
  });
});

describe("presence", () => {
  it("shows who views a dork while their stream is open", async () => {
    const { h } = await setup();
    const ada = { kind: "member" as const, member: { id: "u_ada", name: "Ada", email: "", org: ORG, role: "member" as const, plan: "collab" as const } };
    const seen: unknown[] = [];
    h.app.hub.on((c) => void (c.t === "presence" && seen.push(c)));
    const close = openStream(h.app, ada, "tab-aaaaaaaa");
    setViewing(h.app, ada, "tab-aaaaaaaa", "d1");
    setViewing(h.app, { kind: "local" }, "tab-bbbbbbbb", "d1");
    expect(viewersOf(h.app, "d1").map((v) => v.name)).toEqual(["Ada", "Owner"]);
    close();
    expect(viewersOf(h.app, "d1").map((v) => v.name)).toEqual(["Owner"]); // the owner's tab posted but has no stream: kept for a grace minute
    await h.advance(61_000);
    setViewing(h.app, ada, "tab-cccccccc", null);
    expect(viewersOf(h.app, "d1")).toEqual([]);
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });
});
