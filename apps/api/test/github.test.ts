import { describe, expect, it } from "vitest";
import { agentTokenScope, createAppJwt, createInstallationToken, createIssueComment, GithubHttpError, listCheckSuites, getPullRequest, parsePullRequestEvent, verifyWebhook } from "../src/lib/github";

async function keyPair() {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  return { pem, pub: kp.publicKey };
}
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("github", () => {
  it("signs a verifiable RS256 app JWT with the right claims", async () => {
    const { pem, pub } = await keyPair();
    const jwt = await createAppJwt("12345", pem, 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, unb64(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
    expect(JSON.parse(atob(p))).toEqual({ iat: 1_000_000 - 60, exp: 1_000_000 + 540, iss: "12345" });
  });

  it("rejects a PKCS#1 key with a helpful error", async () => {
    await expect(createAppJwt("1", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).rejects.toThrow(/PKCS#8/);
  });

  it("requests an installation token with a User-Agent", async () => {
    const { pem } = await keyPair();
    let seen: Request | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init);
      return Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 });
    }) as unknown as typeof fetch;
    const t = await createInstallationToken({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, 42, fake);
    expect(t.token).toBe("ghs_x");
    expect(seen!.url).toContain("/app/installations/42/access_tokens");
    expect(seen!.headers.get("user-agent")).toBeTruthy();
    expect(await seen!.text()).toBe(""); // unscoped when no scope is given
  });

  it("scopes an installation token to one repo with push + PR permissions only", async () => {
    const { pem } = await keyPair();
    let seen: Request | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init);
      return Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 });
    }) as unknown as typeof fetch;
    await createInstallationToken({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, 42, fake, agentTokenScope());
    expect(seen!.headers.get("content-type")).toBe("application/json");
    // installation-wide: no `repositories` filter, so the agent can work in any repo the installation reaches
    expect(await seen!.json()).toEqual({
      permissions: { contents: "write", pull_requests: "write", issues: "write", workflows: "write", checks: "read", actions: "read", statuses: "read" },
    });
  });

  it("surfaces GitHub rejections (e.g. 422 for a permission the App lacks) without leaking the body", async () => {
    const { pem } = await keyPair();
    const fake = (async () => Response.json({ message: "secret-ish" }, { status: 422 })) as unknown as typeof fetch;
    await expect(createInstallationToken({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, 42, fake, agentTokenScope())).rejects.toThrow(/422$/);
    await expect(createInstallationToken({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, 42, fake)).rejects.toMatchObject({ status: 422 });
    await expect(createInstallationToken({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, 42, fake)).rejects.toBeInstanceOf(GithubHttpError);
  });

  it("reports the repositories a scoped token covers as owner/name", async () => {
    const { pem } = await keyPair();
    const fake = (async () => Response.json({ token: "ghs_x", expires_at: "2030-01-01T00:00:00Z", repositories: [{ full_name: "octo/hello" }] }, { status: 201 })) as unknown as typeof fetch;
    expect((await createInstallationToken({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }, 42, fake, { repositories: ["hello"] })).repositories).toEqual(["octo/hello"]);
  });

  describe("getPullRequest", () => {
    const pr = { title: "Fix it", state: "open", merged: false, mergeable: true, head: { ref: "agent/x", sha: "abc" }, base: { ref: "main", repo: { full_name: "Octo/Hello" } } };
    const serve = (body: unknown, status = 200) => {
      const seen: Request[] = [];
      const fake = (async (url: string, init: RequestInit) => (seen.push(new Request(url, init)), Response.json(body, { status }))) as unknown as typeof fetch;
      return { seen, fake };
    };

    it("maps the PR and authenticates with the token", async () => {
      const { seen, fake } = serve(pr);
      expect(await getPullRequest("ghs_t", "octo/hello", 7, fake)).toEqual({ title: "Fix it", headRef: "agent/x", headSha: "abc", baseRef: "main", repo: "Octo/Hello", state: "open", mergeable: true });
      expect(seen[0].url).toBe("https://api.github.com/repos/octo/hello/pulls/7");
      expect(seen[0].headers.get("authorization")).toBe("Bearer ghs_t");
    });

    it("distinguishes merged from closed, and keeps mergeable null until GitHub computes it", async () => {
      expect(await getPullRequest("t", "o/r", 1, serve({ ...pr, state: "closed", merged: true, mergeable: null }).fake)).toMatchObject({ state: "merged", mergeable: null });
      expect(await getPullRequest("t", "o/r", 1, serve({ ...pr, state: "closed" }).fake)).toMatchObject({ state: "closed" });
    });

    it("throws a status-only GithubHttpError on non-2xx", async () => {
      await expect(getPullRequest("t", "o/r", 1, serve({ message: "secret-ish" }, 404).fake)).rejects.toMatchObject({ status: 404, message: "GitHub pull request lookup failed: 404" });
    });
  });

  describe("listCheckSuites", () => {
    it("lists the commit's suites with their status, conclusion and run count", async () => {
      const seen: Request[] = [];
      const body = { total_count: 2, check_suites: [{ id: 1, status: "completed", conclusion: "success", latest_check_runs_count: 3, app: { slug: "github-actions" } }, { id: 2, status: "in_progress", conclusion: null, latest_check_runs_count: 1 }] };
      const fake = (async (url: string, init: RequestInit) => (seen.push(new Request(url, init)), Response.json(body))) as unknown as typeof fetch;
      expect(await listCheckSuites("ghs_t", "octo/hello", "abc123", fake)).toEqual([
        { status: "completed", conclusion: "success", checkRuns: 3 }, { status: "in_progress", conclusion: null, checkRuns: 1 },
      ]);
      expect(seen[0].url).toBe("https://api.github.com/repos/octo/hello/commits/abc123/check-suites?per_page=100");
      expect(seen[0].headers.get("authorization")).toBe("Bearer ghs_t");
    });

    it("throws a status-only GithubHttpError on non-2xx", async () => {
      const fake = (async () => Response.json({ message: "nope" }, { status: 404 })) as unknown as typeof fetch;
      await expect(listCheckSuites("t", "o/r", "abc", fake)).rejects.toMatchObject({ status: 404, message: "GitHub check suites lookup failed: 404" });
    });
  });

  describe("createIssueComment", () => {
    it("posts the body to the issue comments endpoint with the token", async () => {
      const seen: Request[] = [];
      const fake = (async (url: string, init: RequestInit) => (seen.push(new Request(url, init)), Response.json({ id: 1 }, { status: 201 }))) as unknown as typeof fetch;
      await createIssueComment("ghs_t", "octo/hello", 7, "CI is red", fake);
      expect(seen[0].url).toBe("https://api.github.com/repos/octo/hello/issues/7/comments");
      expect(seen[0].method).toBe("POST");
      expect(seen[0].headers.get("authorization")).toBe("Bearer ghs_t");
      expect(await seen[0].json()).toEqual({ body: "CI is red" });
    });

    it("throws a status-only GithubHttpError on non-2xx", async () => {
      const fake = (async () => Response.json({ message: "secret-ish" }, { status: 403 })) as unknown as typeof fetch;
      await expect(createIssueComment("t", "o/r", 1, "x", fake)).rejects.toMatchObject({ status: 403, message: "GitHub comment failed: 403" });
    });
  });

  it("verifies webhook signatures", async () => {
    const body = '{"a":1}';
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const sig = "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyWebhook("whsec", body, sig)).toBe(true);
    expect(await verifyWebhook("whsec", body + " ", sig)).toBe(false);
    expect(await verifyWebhook("other", body, sig)).toBe(false);
    expect(await verifyWebhook("whsec", body, null)).toBe(false);
    expect(await verifyWebhook("whsec", body, "sha256=zz")).toBe(false);
  });

  it("maps PR events and ignores forks / other actions", () => {
    const pr = (over: object, action = "opened") => ({ action, repository: { full_name: "o/r" }, pull_request: { number: 7, html_url: "u", merged: false, head: { ref: "agent/abc", repo: { full_name: "o/r" } }, ...over } });
    expect(parsePullRequestEvent(pr({}))).toMatchObject({ kind: "pr_opened", repo: "o/r", branch: "agent/abc", number: 7 });
    expect(parsePullRequestEvent(pr({ merged: true }, "closed"))).toMatchObject({ kind: "pr_merged" });
    expect(parsePullRequestEvent(pr({}, "closed"))).toBeNull();
    expect(parsePullRequestEvent(pr({ head: { ref: "agent/abc", repo: { full_name: "fork/r" } } }))).toBeNull();
  });
});
