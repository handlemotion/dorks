import { File } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { macBaseUrl, useMacs } from "./macs";

/**
 * Uploads a picked photo (`POST /api/images`) and resolves its id; the message names it `![name](dorks-image:<id>)`. Sent here rather
 * than through `client.api.uploadImage`, which expects a DOM Blob: a file on the phone goes up as its bytes with its type.
 */
export async function uploadImage(macId: string, token: string, uri: string, mime: string): Promise<string> {
  const bytes = new Uint8Array(await new File(uri).arrayBuffer());
  const res = await expoFetch(`${macBaseUrl(macId)}/api/images`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": mime }, body: bytes });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(json.error?.message ?? `Upload failed (${res.status}).`);
  return json.id;
}

/** How a message's image loads: `dorks-image:<id>` through the relay (`GET /api/images/:id`, with the session token), anything else as written. */
export function useImageSource(): (src: string) => { uri: string; headers?: Record<string, string> } {
  const { mac, token } = useMacs();
  return (src) => {
    const id = /^dorks-image:([0-9a-f]{32})$/.exec(src)?.[1];
    if (!id || !mac) return { uri: src };
    return { uri: `${macBaseUrl(mac.id)}/api/images/${id}`, headers: { authorization: `Bearer ${token}` } };
  };
}
