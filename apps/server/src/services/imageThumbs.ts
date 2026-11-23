import type { App } from "../app";
import { imageBytes } from "./bridge";

// Smaller copies of the shared images (GET /images/:id?w=640), for everywhere the app shows a screenshot small: the Artifacts grid, the
// viewer's thumbnail strip, a screenshot in the thread. A full-size screenshot is often 2880 px wide and near a megabyte of PNG, and the
// webview decodes all of it to draw a 250 px tile; the copy is a WebP of a few dozen kilobytes. Made on first request and kept beside the
// original (`image_thumbs`, deleted with it), so each is made once.

/** The widths a copy can have; a request is served at the smallest one at least as wide (the largest past them). */
export const THUMB_WIDTHS = [640, 1280] as const;

/** `Bun.Image` (Bun 1.3.14+, the sidecar's runtime). Absent under Node (the tests) or an older Bun: the original is served instead. */
type BunImage = {
  metadata(): Promise<{ width: number; height: number; format: string }>;
  resize(width: number): BunImage;
  webp(opts?: { quality?: number }): { bytes(): Promise<Uint8Array> };
};
const BunImage = (globalThis as { Bun?: { Image?: new (bytes: Uint8Array) => BunImage } }).Bun?.Image;

/** The copy width for a requested width, or null when the request asks for none. */
export function thumbWidth(requested: unknown): number | null {
  const w = Number(requested);
  if (!Number.isFinite(w) || w <= 0) return null;
  return THUMB_WIDTHS.find((t) => t >= w) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
}

const making = new Map<string, Promise<{ mime: string; bytes: Uint8Array } | null>>();

/**
 * The image at `width` (a `THUMB_WIDTHS` value): its stored copy, else one made now and stored. Null when there is no such image;
 * the original when no copy can be made or it would not be smaller (an image already that narrow, an animated GIF, a decode failure).
 */
export async function imageThumb(app: App, id: string, width: number): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const stored = app.db.get("SELECT mime, bytes FROM image_thumbs WHERE id = ? AND width = ?", id, width);
  if (stored) return { mime: stored.mime as string, bytes: stored.bytes as Uint8Array };
  const original = imageBytes(app, id);
  if (!original || !BunImage || original.mime === "image/gif") return original;
  const key = `${id}:${width}`;
  let job = making.get(key);
  if (!job) {
    job = makeThumb(app, id, width, original).finally(() => making.delete(key));
    making.set(key, job);
  }
  return job;
}

async function makeThumb(app: App, id: string, width: number, original: { mime: string; bytes: Uint8Array }) {
  try {
    const image = new BunImage!(original.bytes);
    const { width: full } = await image.metadata();
    if (full <= width) return original;
    const bytes = await image.resize(width).webp({ quality: 82 }).bytes();
    if (bytes.length >= original.bytes.length) return original;
    // The image may have been deleted meanwhile (the reference fails): the copy is simply not kept.
    try {
      app.db.run("INSERT OR IGNORE INTO image_thumbs (id, width, mime, bytes) VALUES (?, ?, ?, ?)", id, width, "image/webp", bytes);
    } catch {
      /* not kept */
    }
    return { mime: "image/webp", bytes };
  } catch {
    return original;
  }
}
