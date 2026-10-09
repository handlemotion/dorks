import { describe, expect, it } from "vitest";
import { exchangeUserCode, userHasInstallation, verifyInstallationOwnership } from "../convex/lib/githubInstall";

const app = { clientId: "cid", clientSecret: "csecret" };

/** Fake GitHub: users own installations; codes map to user tokens. */
function fakeGithub(opts: { owned: number[]; codes?: Record<string, string>; pageSize?: number }) {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect(new Headers(init?.headers).get("user-agent")).toBeTruthy();
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(init!.body as string);
      expect(body.client_id).toBe("cid");
      const token = (opts.codes ?? { good: "ghu_alice" })[body.code];
      return Response.json(token ? { access_token: token } : { error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") return Response.json({ login: "alice" });
    const u = new URL(url);
    const page = Number(u.searchParams.get("page"));
    const size = opts.pageSize ?? 100;
    const slice = opts.owned.slice((page - 1) * size, page * size);
    return Response.json({ total_count: opts.owned.length, installations: slice.map((id) => ({ id })) });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("github installation ownership", () => {
  it("accepts an installation the user can see, and reports their GitHub login", async () => {
    const { fetcher } = fakeGithub({ owned: [11, 22] });
    expect(await verifyInstallationOwnership("good", 22, app, fetcher)).toEqual({ login: "alice" });
  });

  it("rejects someone else's installation id (the review's attack)", async () => {
    const { fetcher } = fakeGithub({ owned: [11, 22] });
    expect(await verifyInstallationOwnership("good", 999, app, fetcher)).toBeNull();
  });

  it("rejects an invalid or replayed code without leaking it", async () => {
    const { fetcher } = fakeGithub({ owned: [11] });
    await expect(verifyInstallationOwnership("stolen-code-123", 11, app, fetcher)).rejects.toThrow(/rejected: bad_verification_code/);
    await expect(exchangeUserCode("stolen-code-123", app, fetcher)).rejects.not.toThrow(/stolen-code-123/);
  });

  it("pages through all installations", async () => {
    const owned = Array.from({ length: 250 }, (_, i) => i + 1);
    const { fetcher, calls } = fakeGithub({ owned, pageSize: 100 });
    expect(await userHasInstallation("ghu_alice", 250, fetcher)).toBe(true);
    expect(calls.filter((c) => c.includes("page=")).length).toBe(3);
    expect(await userHasInstallation("ghu_alice", 251, fetcher)).toBe(false);
  });

  it("propagates GitHub outages instead of treating them as 'not owned'", async () => {
    const down = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(userHasInstallation("t", 1, down)).rejects.toThrow(/502/);
  });
});
