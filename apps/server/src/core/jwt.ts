// Verifying the cloud's short-lived identity tokens (docs/cloud.md, "Identity"): EdDSA (Ed25519) JWTs signed by dorks-cloud's
// Better Auth jwt plugin, checked against its JWKS. The keys are cached and fetched again when a token names a key id the cache
// does not hold (a rotation), at most once per REFETCH_MS, and every KEYS_TTL_MS otherwise. Nothing here trusts the relay: a token
// is good only when its signature checks out against the cloud's published keys.

const KEYS_TTL_MS = 10 * 60_000;
const REFETCH_MS = 30_000;
/** Clock skew allowed on exp and nbf. */
const SKEW_S = 30;

export type JwtClaims = Record<string, unknown> & { sub?: unknown; exp?: unknown; nbf?: unknown };

export interface JwksVerifier {
  /** The token's claims when its signature, exp and nbf check out; throws otherwise (the message is safe to log). */
  verify(token: string): Promise<JwtClaims>;
}

type Jwk = { kty?: string; crv?: string; x?: string; kid?: string; alg?: string; use?: string };

const b64urlBytes = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const b64urlJson = (s: string): unknown => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** `issuer`: both `iss` and `aud` must name it (the cloud's own URL, Better Auth's BETTER_AUTH_URL). */
export function remoteJwks(url: string, opts: { issuer: string; fetch?: typeof fetch; now?: () => number }): JwksVerifier {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = 0;
  let inflight: Promise<void> | undefined;

  const load = () =>
    (inflight ??= (async () => {
      try {
        const res = await doFetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`jwks: ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        const next = new Map<string, CryptoKey>();
        for (const k of body.keys ?? []) {
          if (k.kty !== "OKP" || k.crv !== "Ed25519" || !k.x || (k.use && k.use !== "sig")) continue;
          const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]);
          next.set(k.kid ?? "", key);
        }
        keys = next;
      } finally {
        fetchedAt = now();
        inflight = undefined;
      }
    })());

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    const stale = now() - fetchedAt > KEYS_TTL_MS;
    if (stale || (!keys.has(kid) && now() - fetchedAt > REFETCH_MS)) await load().catch(() => {}); // an unreachable cloud keeps the cached keys
    return keys.get(kid) ?? (kid === "" && keys.size === 1 ? [...keys.values()][0] : undefined);
  };

  return {
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("jwt: malformed");
      let header: { alg?: string; kid?: string; typ?: string };
      let claims: JwtClaims;
      try {
        header = b64urlJson(parts[0]) as typeof header;
        claims = b64urlJson(parts[1]) as JwtClaims;
      } catch {
        throw new Error("jwt: malformed");
      }
      if (header.alg !== "EdDSA" && header.alg !== "Ed25519") throw new Error("jwt: unsupported alg");
      if (!claims || typeof claims !== "object") throw new Error("jwt: malformed");
      const key = await keyFor(typeof header.kid === "string" ? header.kid : "");
      if (!key) throw new Error("jwt: unknown key");
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      if (!ok) throw new Error("jwt: bad signature");
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== opts.issuer || !aud.includes(opts.issuer)) throw new Error("jwt: wrong issuer or audience");
      const t = now() / 1000;
      if (typeof claims.exp !== "number" || claims.exp + SKEW_S < t) throw new Error("jwt: expired");
      if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > t) throw new Error("jwt: not yet valid");
      return claims;
    },
  };
}
