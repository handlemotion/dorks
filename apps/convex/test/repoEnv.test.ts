/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { aad, decrypt, keyringFromEnv } from "../core/crypto";
import { pickSecrets } from "../core/env";

vi.mock("../convex/auth", () => ({
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    return id.subject;
  },
}));

const modules = import.meta.glob("../convex/**/*.*s");
const code = (e: unknown) => (e as { data?: { code?: string } }).data?.code;
const rejects = async (p: Promise<unknown>) => p.then(() => undefined, (e) => code(e));
const ring = () => keyringFromEnv({ ENCRYPTION_KEY: process.env.ENCRYPTION_KEY! });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
});

describe("pickSecrets: which variables a dork's sandbox gets", () => {
  const s = (name: string, repo?: string) => ({ name, repo, valueEnc: `${name}@${repo ?? "*"}` });
  it("account-wide ones plus the dork's own repo's, the repo's value winning; other repos' never", () => {
    const rows = [s("A"), s("B"), s("B", "o/r"), s("C", "o/other"), s("D", "o/r")];
    const got = pickSecrets(rows, "o/r");
    expect(Object.fromEntries(got.map((x) => [x.name, x.valueEnc]))).toEqual({ A: "A@*", B: "B@o/r", D: "D@o/r" });
  });
  it("matches the repo whatever its casing", () => {
    expect(pickSecrets([s("A", "o/r")], "O/R").map((x) => x.name)).toEqual(["A"]);
  });
});

describe("per-repo variables", () => {
  const setup = () => {
    const t = convexTest(schema, modules);
    return { t, u1: t.withIdentity({ subject: "u1" }), u2: t.withIdentity({ subject: "u2" }) };
  };
  const rows = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("userSecrets").collect());

  it("a repo's variable is stored under the normalized repo, bound to it, and is separate from the account-wide one of the same name", async () => {
    const { t, u1 } = setup();
    await u1.mutation(api.settings.setCliSecret, { name: "TOKEN", value: "everywhere" });
    await u1.mutation(api.settings.setCliSecret, { name: "TOKEN", value: "only-here", repo: "Acme/Widget" });
    const stored = await rows(t);
    expect(stored).toHaveLength(2);
    const repoRow = stored.find((r) => r.repo)!;
    expect(repoRow.repo).toBe("acme/widget");
    expect(await decrypt(ring(), repoRow.valueEnc, aad.secret("u1", "TOKEN", "acme/widget"))).toBe("only-here");
    // the ciphertext cannot be moved to another repo's row or to the account-wide scope
    await expect(decrypt(ring(), repoRow.valueEnc, aad.secret("u1", "TOKEN", "acme/other"))).rejects.toThrow();
    await expect(decrypt(ring(), repoRow.valueEnc, aad.secret("u1", "TOKEN"))).rejects.toThrow();
    const wide = stored.find((r) => !r.repo)!;
    expect(await decrypt(ring(), wide.valueEnc, aad.secret("u1", "TOKEN"))).toBe("everywhere");
  });

  it("setting a scope again overwrites it rather than adding a row; the list shows scopes and no values", async () => {
    const { t, u1 } = setup();
    await u1.mutation(api.settings.setCliSecret, { name: "K", value: "1", repo: "o/r" });
    await u1.mutation(api.settings.setCliSecret, { name: "K", value: "2", repo: "O/R" });
    await u1.mutation(api.settings.setCliSecret, { name: "A", value: "1" });
    expect(await rows(t)).toHaveLength(2);
    expect(await u1.query(api.settings.secretList, {})).toEqual([{ name: "A", repo: null }, { name: "K", repo: "o/r" }]);
    expect(await u1.query(api.settings.secretNames, {})).toEqual(["A", "K"]);
  });

  it("removing one scope leaves the other; other users are untouched; bad repos are refused", async () => {
    const { t, u1, u2 } = setup();
    await u1.mutation(api.settings.setCliSecret, { name: "K", value: "1" });
    await u1.mutation(api.settings.setCliSecret, { name: "K", value: "2", repo: "o/r" });
    await u2.mutation(api.settings.setCliSecret, { name: "K", value: "3", repo: "o/r" });
    await u1.mutation(api.settings.removeCliSecret, { name: "K", repo: "O/r" });
    expect((await rows(t)).map((r) => `${r.userId}:${r.repo ?? "*"}`).sort()).toEqual(["u1:*", "u2:o/r"]);
    expect(await rejects(u1.mutation(api.settings.setCliSecret, { name: "K", value: "1", repo: "not-a-repo" }))).toBe("invalid");
    expect(await rejects(u1.mutation(api.settings.removeCliSecret, { name: "K", repo: "../x" }))).toBe("invalid");
  });

  it("the 50 variable cap counts every scope", async () => {
    const { u1 } = setup();
    for (let i = 0; i < 25; i++) await u1.mutation(api.settings.setCliSecret, { name: `W${i}`, value: "v" });
    for (let i = 0; i < 25; i++) await u1.mutation(api.settings.setCliSecret, { name: `R${i}`, value: "v", repo: "o/r" });
    expect(await rejects(u1.mutation(api.settings.setCliSecret, { name: "MORE", value: "v", repo: "o/other" }))).toBe("limit");
  });
});
