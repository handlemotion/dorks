// Draws the menu-bar template icon with no dependencies (a PNG encoder in ~20 lines).
//   icons/tray.png    44x44 monochrome template image for the menu bar (black on transparent; macOS tints it)
// The app icon is no longer drawn here: its source is icons/source.svg (a #f2f2f2 tile with a thin grey ring, as wide as the tile and cut
// off at the bottom), rendered to icons/source.png at 1024px; then `pnpm tauri icon src-tauri/icons/source.png`. `appIcon` below is unused.
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// coverage of a shape at a pixel from its signed distance (negative inside), 1px antialiasing
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));

function render(size, shade) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = shade(x + 0.5, y + 0.5, size);
      rgba.set(
        px.map((v) => Math.round(v)),
        (y * size + x) * 4,
      );
    }
  }
  return png(size, size, rgba);
}

const over = (dst, src, a) => {
  const da = dst[3] / 255;
  const outA = a + da * (1 - a);
  if (outA === 0) return [0, 0, 0, 0];
  return [0, 1, 2].map((i) => (src[i] * a + dst[i] * da * (1 - a)) / outA).concat(outA * 255);
};

function appIcon(x, y, s) {
  const c = s / 2;
  // rounded square, 10% inset (macOS icon grid), corner radius ~22%
  const half = s * 0.4,
    r = s * 0.18;
  const qx = Math.abs(x - c) - (half - r),
    qy = Math.abs(y - c) - (half - r);
  const dSquare = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  let px = [0, 0, 0, 0];
  px = over(px, [24, 24, 27], cover(dSquare));
  const d = Math.hypot(x - c, y - c);
  px = over(px, [250, 250, 250], cover(Math.abs(d - s * 0.2) - s * 0.045)); // ring
  px = over(px, [250, 250, 250], cover(d - s * 0.075)); // dot
  return px;
}

function trayIcon(x, y, s) {
  const c = s / 2,
    d = Math.hypot(x - c, y - c);
  let px = [0, 0, 0, 0];
  px = over(px, [0, 0, 0], cover(Math.abs(d - s * 0.34) - s * 0.075));
  px = over(px, [0, 0, 0], cover(d - s * 0.13));
  return px;
}

mkdirSync(new URL("../src-tauri/icons/", import.meta.url), { recursive: true });
writeFileSync(new URL("../src-tauri/icons/tray.png", import.meta.url), render(44, trayIcon));
console.log("wrote src-tauri/icons/tray.png");
