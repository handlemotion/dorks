// The bridge's identity is HMAC(BRIDGE_SECRET_KEY, dorkId): derived, so nothing is stored and a retried create_box hands
// the box the same secret. Verification is constant-time (subtle.verify).
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const hmacKey = (usage: "sign" | "verify") => {
  const k = process.env.BRIDGE_SECRET_KEY;
  if (!k) throw new Error("BRIDGE_SECRET_KEY not set");
  return crypto.subtle.importKey("raw", enc.encode(k), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
};

export async function bridgeSecret(dorkId: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey("sign"), enc.encode(`bridge|${dorkId}`)));
}

export async function verifyBridgeSecret(dorkId: string, presented: string): Promise<boolean> {
  const m = /^[0-9a-f]{64}$/.exec(presented);
  if (!m) return false;
  const sig = Uint8Array.from(presented.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey("verify"), sig, enc.encode(`bridge|${dorkId}`));
}
