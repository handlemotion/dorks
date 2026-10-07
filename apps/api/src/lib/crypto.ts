// AES-GCM envelope: "v{keyVersion}:{iv}:{ciphertext}" (base64url). AAD binds a ciphertext to its owner/purpose
// so it cannot be copied to another row.
const b64 = {
  enc: (b: ArrayBuffer | Uint8Array) => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    let s = "";
    for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

export interface Keyring {
  current: number;
  keys: Record<number, string>; // version -> base64 32-byte key
}

/** Single key from the ENCRYPTION_KEY secret (version 1). Add versions here to rotate. */
export const keyringFromEnv = (env: Pick<Env, "ENCRYPTION_KEY">): Keyring => ({ current: 1, keys: { 1: env.ENCRYPTION_KEY } });

async function importKey(b64key: string) {
  const raw = Uint8Array.from(atob(b64key), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("encryption key must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(ring: Keyring, plaintext: string, aad: string): Promise<{ value: string; keyVersion: number }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(ring.keys[ring.current]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(plaintext));
  return { value: `v${ring.current}:${b64.enc(iv)}:${b64.enc(ct)}`, keyVersion: ring.current };
}

export async function decrypt(ring: Keyring, envelope: string, aad: string): Promise<string> {
  const [v, iv, ct] = envelope.split(":");
  const version = Number(v?.slice(1));
  if (!v?.startsWith("v") || !ring.keys[version] || !iv || !ct) throw new Error("bad envelope");
  const key = await importKey(ring.keys[version]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(iv), additionalData: new TextEncoder().encode(aad) }, key, b64.dec(ct));
  return new TextDecoder().decode(pt);
}

/** Canonical AAD strings. */
export const aad = {
  claudeToken: (userId: string) => `${userId}|claude_token`,
  secret: (userId: string, name: string) => `${userId}|secret|${name}`,
};
