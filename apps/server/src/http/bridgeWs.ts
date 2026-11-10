import type { AppError } from "@dorks/shared";
import { AppFail, type App, type Change } from "../app";
import { verifyBridgeSecret } from "../lib/bridgeAuth";
import * as bridge from "../services/bridge";

// One authenticated bridge socket (docs/architecture.md, "Bridge protocol"). Transport-neutral: the listener (main.ts) feeds it
// text frames and gives it `send` / `close`, so the protocol is testable without a socket.

export const AUTH_TIMEOUT_MS = 5_000;
export const CLOSE_FORBIDDEN = 4403;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface SocketIO {
  send(text: string): void;
  close(code: number, reason?: string): void;
}

const failure = (e: unknown): AppError => {
  if (e instanceof AppFail) return e.error;
  console.error("bridge rpc failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
  return { code: "failed", message: "Something went wrong" };
};

type Args = Record<string, unknown>;

export class BridgeSession {
  private dorkId?: string;
  private off?: () => void;
  private authTimer?: ReturnType<typeof setTimeout>;
  private recompute?: ReturnType<typeof setTimeout>;
  private lastCommands = "";
  private lastSubs = "";
  private closed = false;
  private authenticating = false;

  constructor(private readonly app: App, private readonly io: SocketIO) {}

  open() {
    this.authTimer = setTimeout(() => this.io.close(CLOSE_FORBIDDEN, "auth timeout"), AUTH_TIMEOUT_MS);
  }

  close() {
    this.closed = true;
    clearTimeout(this.authTimer);
    clearTimeout(this.recompute);
    this.off?.();
  }

  private send(o: object) {
    if (!this.closed) this.io.send(JSON.stringify(o));
  }

  async onMessage(raw: string) {
    if (raw.length > MAX_FRAME_BYTES) return this.io.close(1009, "frame too large");
    let msg: { t?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.io.close(1003, "bad json");
    }
    if (!this.dorkId) {
      if (this.authenticating) return; // one auth attempt at a time
      this.authenticating = true;
      return this.authenticate(msg);
    }
    if (msg.t !== "rpc" || typeof msg.id !== "number" || typeof msg.op !== "string") return;
    const id = msg.id;
    try {
      const result = await this.rpc(msg.op, (msg.args ?? {}) as Args);
      this.send({ t: "res", id, ok: true, result: result === undefined ? {} : result }); // null is a real answer (configure refused)
    } catch (e) {
      this.send({ t: "res", id, ok: false, error: failure(e) });
    }
  }

  private async authenticate(msg: { t?: unknown; [k: string]: unknown }) {
    const { dorkId, secret } = msg;
    const ok = msg.t === "auth" && typeof dorkId === "string" && typeof secret === "string" && (await verifyBridgeSecret(this.app.cfg.bridgeSecretKey, dorkId, secret));
    let known = false;
    if (ok) {
      try {
        bridge.bridgeDork(this.app, dorkId as string);
        known = true;
      } catch {
        /* deleted or unknown */
      }
    }
    if (!known || this.closed) return this.io.close(CLOSE_FORBIDDEN, "forbidden");
    clearTimeout(this.authTimer);
    this.dorkId = dorkId as string;
    this.send({ t: "auth_ok" });
    this.off = this.app.hub.on((c) => this.onChange(c));
    this.publish();
  }

  private async rpc(op: string, args: Args): Promise<unknown> {
    const dorkId = this.dorkId!;
    switch (op) {
      case "connect":
        return bridge.connect(this.app, dorkId);
      case "heartbeat":
        return bridge.heartbeat(this.app, dorkId);
      case "push":
        return bridge.push(this.app, dorkId, args.frames as unknown[]);
      case "configure":
        return bridge.configure(this.app, dorkId);
      case "gh_token":
        return bridge.ghToken(this.app, dorkId);
      case "subscribe_pr":
        return bridge.subscribePr(this.app, dorkId, args.repo as string, args.number as number, args.source as "auto" | "agent");
      case "unsubscribe_pr":
        return bridge.unsubscribePr(this.app, dorkId, args.repo as string, args.number as number);
      default:
        throw new AppFail({ code: "invalid", message: `unknown op: ${op}` });
    }
  }

  private onChange(c: Change) {
    if (!this.dorkId || !("dorkId" in c) || c.dorkId !== this.dorkId) return;
    if (c.t === "events") return;
    this.recompute ??= setTimeout(() => {
      this.recompute = undefined;
      this.publish();
    }, 0); // coalesce a burst of changes into one snapshot
  }

  /** Sends the commands and subscriptions snapshots if they differ from what the bridge last saw. */
  publish() {
    if (!this.dorkId || this.closed) return;
    const commands = JSON.stringify(bridge.commandsFor(this.app, this.dorkId));
    if (commands !== this.lastCommands) {
      this.lastCommands = commands;
      this.send({ t: "commands", cmds: JSON.parse(commands) });
    }
    const subs = JSON.stringify(bridge.subscriptionsFor(this.app, this.dorkId));
    if (subs !== this.lastSubs) {
      this.lastSubs = subs;
      this.send({ t: "subscriptions", views: JSON.parse(subs) });
    }
  }
}
