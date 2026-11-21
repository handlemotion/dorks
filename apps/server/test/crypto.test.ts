import { describe, expect, it } from "vite-plus/test";
import { aad, decrypt, encrypt, type Keyring } from "../src/core/crypto";

const k = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const ring: Keyring = { current: 1, keys: { 1: k(1) } };

describe("crypto", () => {
  it("round-trips and uses a fresh IV", async () => {
    const a = await encrypt(ring, "sk-secret", aad.claudeToken("u1"));
    const b = await encrypt(ring, "sk-secret", aad.claudeToken("u1"));
    expect(a.value).not.toBe(b.value);
    expect(a.value).not.toContain("sk-secret");
    expect(await decrypt(ring, a.value, aad.claudeToken("u1"))).toBe("sk-secret");
  });
  it("rejects wrong AAD (ciphertext moved to another user/name)", async () => {
    const a = await encrypt(ring, "x", aad.secret("u1", "A"));
    await expect(decrypt(ring, a.value, aad.secret("u2", "A"))).rejects.toThrow();
    await expect(decrypt(ring, a.value, aad.secret("u1", "B"))).rejects.toThrow();
  });
  it("supports key rotation", async () => {
    const old = await encrypt(ring, "x", "a");
    const rotated: Keyring = { current: 2, keys: { 1: k(1), 2: k(2) } };
    expect(await decrypt(rotated, old.value, "a")).toBe("x");
    expect((await encrypt(rotated, "x", "a")).keyVersion).toBe(2);
  });
  it("rejects a bad key length", async () => {
    await expect(encrypt({ current: 1, keys: { 1: btoa("short") } }, "x", "a")).rejects.toThrow(/32 bytes/);
  });
});
