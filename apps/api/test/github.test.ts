import { describe, expect, it } from "vitest";
import { createAppJwt, createInstallationToken, parsePullRequestEvent, verifyWebhook } from "../src/lib/github";

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
