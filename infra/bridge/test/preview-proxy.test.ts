import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { insertAt, OVERLAY_PATH, PreviewProxies } from "../src/preview-proxy";
import { tmp } from "./helpers";

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

/** A stand-in dev server: records what it was sent, answers per path, echoes on a WebSocket. */
async function devServer() {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/go") return void res.writeHead(302, { location: `http://localhost:${port}/there?x=1` }).end();
    if (req.url === "/data.json") return void res.writeHead(200, { "content-type": "application/json", "content-length": "2" }).end("{}");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    });
    // split mid-tag, to check the tag lands after the whole <head ...>
    res.write("<!doctype html><html><he");
    setTimeout(() => res.end('ad lang="en"><title>t</title></head><body>hi</body></html>'), 5);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    seen.push(req.headers);
    ws.on("message", (m) => ws.send(`echo:${(m as Buffer).toString()}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => {
    wss.close();
    server.closeAllConnections();
    server.close();
  });
  return { port, seen };
}

async function proxyFor(target: number, file = join(tmp("pp-"), "previews.json")) {
  const proxies = new PreviewProxies(file, () => {});
  closers.push(() => proxies.close());
  return { proxies, port: await proxies.forTarget(target), file };
}

const PAGE = { "sec-fetch-dest": "iframe", "accept-encoding": "gzip, br", host: "box-5173.on.boat.dev", origin: "https://box-5173.on.boat.dev", "x-forwarded-host": "box-5173.on.boat.dev" };

describe("preview proxy", () => {
  it("adds the overlay to pages, makes them frameable and the request local", async () => {
    const dev = await devServer();
    const { port } = await proxyFor(dev.port);
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: PAGE });
    expect(await res.text()).toBe(`<!doctype html><html><head lang="en"><script src="${OVERLAY_PATH}"></script><title>t</title></head><body>hi</body></html>`);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    const sent = dev.seen.at(-1)!;
    expect(sent.host).toBe(`localhost:${dev.port}`);
    expect(sent.origin).toBe(`http://localhost:${dev.port}`);
    expect(sent["x-forwarded-host"]).toBeUndefined();
    expect(sent["accept-encoding"]).toBeUndefined();
  });

  it("passes everything else as it is, and makes redirects to the dev server relative", async () => {
    const dev = await devServer();
    const { port } = await proxyFor(dev.port);
    const data = await fetch(`http://127.0.0.1:${port}/data.json`, { headers: { "sec-fetch-dest": "empty", "accept-encoding": "gzip" } });
    expect([await data.text(), data.headers.get("content-length")]).toEqual(["{}", "2"]);
    expect(dev.seen.at(-1)!["accept-encoding"]).toBe("gzip");
    const go = await fetch(`http://127.0.0.1:${port}/go`, { redirect: "manual" });
    expect(go.headers.get("location")).toBe("/there?x=1");
    const overlay = await fetch(`http://127.0.0.1:${port}${OVERLAY_PATH}`);
    expect(overlay.headers.get("content-type")).toMatch(/javascript/);
  });

  it("passes WebSockets through (HMR), with the same local Host and Origin", async () => {
    const dev = await devServer();
    const { port } = await proxyFor(dev.port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (m) => resolve((m as Buffer).toString()));
      ws.on("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo:ping");
    expect(dev.seen.at(-1)!.host).toBe(`localhost:${dev.port}`);
    expect(dev.seen.at(-1)!.origin).toBe(`http://localhost:${dev.port}`);
  });

  it("answers 502 with a page while nothing listens, and listens on the same port again after a restart", async () => {
    const dev = await devServer();
    const first = await proxyFor(dev.port);
    expect(await first.proxies.forTarget(dev.port)).toBe(first.port);
    const other = await devServer(); // two calls at once for one port share one proxy
    const [a, b] = await Promise.all([first.proxies.forTarget(other.port), first.proxies.forTarget(other.port)]);
    expect(a).toBe(b);
    first.proxies.close();
    const again = new PreviewProxies(first.file, () => {});
    closers.push(() => again.close());
    await again.restore();
    expect(await again.forTarget(dev.port)).toBe(first.port);
    const nothing = await proxyFor(1);
    const res = await fetch(`http://127.0.0.1:${nothing.port}/`, { headers: { "sec-fetch-dest": "document" } });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/Nothing answers on port 1/);
  });

  it("puts the tag early even without a <head>", () => {
    expect(insertAt("<!doctype html><body>x", false)).toBe(15);
    expect(insertAt("<!doctype html><html>", false)).toBe(-1);
    expect(insertAt("<!doctype html><html>", true)).toBe(21);
    expect(insertAt("plain", true)).toBe(0);
  });
});
