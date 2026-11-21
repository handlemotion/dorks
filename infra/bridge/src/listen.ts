import { WebSocketServer, type WebSocket } from "ws";
import type { Accept, BridgeSocket } from "./transport";

// The bridge's listener: a WebSocket server on loopback that the box provider exposes as this box's bridge URL (Boat's hosted
// port, behind its per-port token). The server on the owner's machine dials it; the handshake in transport.ts authenticates.

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PING_MS = 30_000;

/** Listens on 127.0.0.1:`port`. A socket that misses two pings in a row is dropped, so a dead connection is noticed. */
export function listenLoopback(port: number, onError: (e: Error) => void): Accept {
  return (onSocket) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: MAX_FRAME_BYTES });
    wss.on("error", onError);
    const alive = new WeakSet<WebSocket>();
    wss.on("connection", (ws) => {
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      onSocket(ws as unknown as BridgeSocket);
    });
    const pings = setInterval(() => {
      for (const ws of wss.clients) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        ws.ping();
      }
    }, PING_MS);
    pings.unref();
    return () => {
      clearInterval(pings);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    };
  };
}
