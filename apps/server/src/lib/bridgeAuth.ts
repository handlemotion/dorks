// The bridge's identity is HMAC(bridgeSecretKey, "bridge|" + dorkId): derived, so nothing is stored and a retried create_box hands
// the box the same secret. It never crosses the bridge socket: both sides prove they hold it (`proof` in @dorks/shared).
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const hmacKey = (key: string, usage: "sign" | "verify") => {
  if (!key) throw new Error("bridge secret key not set");
  return crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
};

export async function bridgeSecret(key: string, dorkId: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), enc.encode(`bridge|${dorkId}`)));
}
