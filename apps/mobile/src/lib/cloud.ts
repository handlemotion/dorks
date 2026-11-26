import { CLOUD_URL, LEGACY_CLOUD_URL } from "./config";

/** A Mac paired with this account (`GET /v1/macs`). */
export interface Mac {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: number | string | null;
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CLOUD_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Cannot reach Dorks Cloud. Check your connection.");
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Request failed (${res.status}).`);
  return json as T;
}

/** The relay's own routes (docs/mobile.md, "Relay"); everything else goes to the Mac through @dorks/client. */
export const cloud = {
  macs: (token: string) => call<Mac[]>(token, "GET", "/v1/macs"),
  unpair: (token: string, id: string) => call<object>(token, "DELETE", `/v1/macs/${encodeURIComponent(id)}`),
  claim: (token: string, code: string) => call<{ macId: string; name: string }>(token, "POST", "/v1/pair/claim", { code }),
};

/** `ABCD-2345`, `abcd2345` -> `ABCD2345`. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The code in a pairing QR code (`dorks://pair?code=ABCD2345&cloud=<origin>`), or null for anything else. */
export function parsePairUrl(data: string): { code: string; cloud: string | null } | null {
  const m = /^dorks:\/\/pair\?(.*)$/.exec(data.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const code = normalizeCode(params.get("code") ?? "");
  return code ? { code, cloud: params.get("cloud") } : null;
}

/** Whether a pairing code was made by the relay this app talks to (a QR code from another one cannot be claimed here). */
export const sameCloud = (cloudUrl: string | null) => {
  const url = cloudUrl?.replace(/\/+$/, "");
  return !url || url === CLOUD_URL || (url === LEGACY_CLOUD_URL && CLOUD_URL === "https://api.dorks.build");
};
