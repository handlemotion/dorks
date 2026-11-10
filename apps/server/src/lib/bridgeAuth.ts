// The bridge's identity is HMAC(bridgeSecretKey, "bridge|" + dorkId): derived, so nothing is stored and a retried create_box hands
// the box the same secret. Verification is constant-time (subtle.verify).
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const hmacKey = (key: string, usage: "sign" | "verify") => {
  if (!key) throw new Error("bridge secret key not set");
  return crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
};

export async function bridgeSecret(key: string, dorkId: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), enc.encode(`bridge|${dorkId}`)));
}

export async function verifyBridgeSecret(key: string, dorkId: string, presented: string): Promise<boolean> {
  if (typeof presented !== "string" || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const sig = Uint8Array.from(presented.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), sig, enc.encode(`bridge|${dorkId}`));
}
