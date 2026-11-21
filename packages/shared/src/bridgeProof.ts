// The bridge handshake's proofs (docs/architecture.md, "Bridge protocol"). The server dials the bridge, so neither side may send
// the per-dork secret itself: each proves it holds it by an HMAC over both nonces, under a label of its own so one side's proof
// can never be replayed as the other's.

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export type ProofLabel = "bridge" | "server";

/** A fresh 32-byte nonce as hex. */
export const newNonce = (): string => hex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);

export const isNonce = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** HMAC-SHA256(secret, `<label>|<theirs>|<mine>`) as hex: `theirs` is the nonce the other side sent, `mine` this side's. */
export async function proof(secret: string, label: ProofLabel, theirs: string, mine: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${label}|${theirs}|${mine}`)));
}

/** Constant-time check of a presented proof. */
export async function checkProof(secret: string, label: ProofLabel, theirs: string, mine: string, presented: unknown): Promise<boolean> {
  if (typeof presented !== "string" || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const want = await proof(secret, label, theirs, mine);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}
