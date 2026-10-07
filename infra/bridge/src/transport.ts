import type { CommandFrame, FromBridge, ToBridge } from "@dorks/shared";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

export interface CommandEntry {
  cid: string;
  frame: CommandFrame;
}

/** What the push mutation may return. Today it returns nothing; the gap-aware backend returns `{ expectedBseq }`. */
export type PushResult = void | null | { expectedBseq?: number } | Record<string, unknown>;

/** The bridge's whole view of the backend. The Convex implementation is below; tests plug in a fake. */
export interface Transport {
  /** Handshake. Resolves with the last bseq the backend stored; rejects with `{ data: { code: "sleeping" } }` when the box should not run. */
  connect(): Promise<{ afterBridgeSeq: number }>;
  push(frames: FromBridge[]): Promise<PushResult>;
  heartbeat(): Promise<void>;
  /** The only way secrets are obtained (actions; never part of the reactive commands query). */
  configure(): Promise<Extract<ToBridge, { t: "configure" }> | null>;
  ghToken(): Promise<string | null>;
  subscribeCommands(onCommands: (cmds: CommandEntry[]) => void, onError: () => void): () => void;
  /** Fires each time the underlying connection comes back after a drop. */
  onReconnect(cb: () => void): () => void;
  /** True when an error means the backend will never accept this bridge (wrong secret / dork deleted): retrying is pointless. */
  isFatal(err: unknown): boolean;
  isSleeping(err: unknown): boolean;
  close(): Promise<void>;
}

const code = (e: unknown) => (e as { data?: { code?: unknown } } | null)?.data?.code;

export class ConvexTransport implements Transport {
  private client: ConvexClient;
  private creds: { dorkId: string; secret: string };

  constructor(url: string, dorkId: string, secret: string) {
    this.client = new ConvexClient(url);
    this.creds = { dorkId, secret };
  }

  connect = async () => {
    const r = await this.client.mutation(anyApi.bridge.connect, this.creds);
    return { afterBridgeSeq: Number(r?.afterBridgeSeq ?? 0) };
  };

  push = (frames: FromBridge[]) => this.client.mutation(anyApi.bridge.push, { ...this.creds, frames }) as Promise<PushResult>;

  heartbeat = async () => {
    await this.client.mutation(anyApi.bridge.heartbeat, this.creds);
  };

  configure = async () => ((await this.client.action(anyApi.bridge.configure, this.creds)) ?? null) as Extract<ToBridge, { t: "configure" }> | null;

  ghToken = async () => {
    const r = (await this.client.action(anyApi.bridge.ghToken, this.creds)) as { token?: string } | null;
    return r?.token ?? null;
  };

  subscribeCommands(onCommands: (cmds: CommandEntry[]) => void, onError: () => void) {
    return this.client.onUpdate(anyApi.bridge.commands, this.creds, (cmds) => onCommands(cmds as CommandEntry[]), onError);
  }

  onReconnect(cb: () => void) {
    let last = this.client.connectionState().connectionCount;
    let wasUp = this.client.connectionState().isWebSocketConnected;
    return this.client.subscribeToConnectionState((s) => {
      const reconnected = s.isWebSocketConnected && (!wasUp || s.connectionCount !== last) && s.connectionCount > last;
      wasUp = s.isWebSocketConnected;
      if (s.connectionCount !== last) last = s.connectionCount;
      if (reconnected) cb();
    });
  }

  isFatal = (e: unknown) => code(e) === "forbidden";
  isSleeping = (e: unknown) => code(e) === "sleeping";
  close = () => this.client.close();
}
