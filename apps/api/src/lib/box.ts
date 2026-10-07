// Thin seam over the sandbox provider (Upstash Box). The Dork lifecycle depends only on this, so SDK/REST details
// (pre-1.0, changes often) stay in one file. The real provider lands with the API key.
export interface BoxProvider {
  /** Must be idempotent on `name`: a retry after a crash returns the box it already made instead of leaking a second. */
  createFromSnapshot(snapshotId: string, opts: { name: string; initCommand: string; env: Record<string, string> }): Promise<{ id: string }>;
  /** Idempotent: resuming a running box is not an error. */
  resume(boxId: string): Promise<void>;
  /** Idempotent: pausing a paused box is not an error. */
  pause(boxId: string): Promise<void>;
  /** Idempotent: deleting a missing box is not an error. */
  delete(boxId: string): Promise<void>;
}

/** Used until UPSTASH_BOX_API_KEY is set: every call fails with a clear, non-secret message. */
export const unconfiguredBox: BoxProvider = {
  async createFromSnapshot() {
    throw new Error("box provider not configured (UPSTASH_BOX_API_KEY)");
  },
  async resume() {
    throw new Error("box provider not configured (UPSTASH_BOX_API_KEY)");
  },
  async pause() {
    throw new Error("box provider not configured (UPSTASH_BOX_API_KEY)");
  },
  async delete() {
    throw new Error("box provider not configured (UPSTASH_BOX_API_KEY)");
  },
};

/** In-memory box for tests and local dev (BOX_PROVIDER=sim). Records calls; can inject failures. */
export class SimBox implements BoxProvider {
  boxes = new Map<string, { name: string; running: boolean }>();
  calls: string[] = [];
  failNext = new Set<string>();
  /** Local dev: print how to start the stand-in bridge (the per-dork secret is otherwise never exposed). */
  announce = false;
  /** Dev only: treat unknown ids as existing (the dev server may have restarted and lost the in-memory map). */
  lenient = false;

  private maybeFail(op: string) {
    if (this.failNext.delete(op)) throw new Error(`injected ${op} failure`);
  }
  async createFromSnapshot(_snap: string, opts: { name: string }) {
    this.calls.push("create");
    this.maybeFail("create");
    for (const [id, b] of this.boxes) if (b.name === opts.name) return { id };
    const id = `box-${this.boxes.size + 1}-${opts.name}`;
    if (this.announce) {
      const e = (opts as { env?: Record<string, string> }).env;
      console.log(`[sim box] start bridge: node infra/bridge-sim/sim.mjs ${e?.DORK_ID} ${e?.BRIDGE_SECRET}`);
    }
    this.boxes.set(id, { name: opts.name, running: true });
    return { id };
  }
  async resume(id: string) {
    this.calls.push("resume");
    this.maybeFail("resume");
    const b = this.boxes.get(id) ?? (this.lenient ? this.boxes.set(id, { name: id, running: false }).get(id) : undefined);
    if (!b) throw new Error("no such box");
    b.running = true;
  }
  async pause(id: string) {
    this.calls.push("pause");
    this.maybeFail("pause");
    const b = this.boxes.get(id);
    if (b) b.running = false;
  }
  async delete(id: string) {
    this.calls.push("delete");
    this.maybeFail("delete");
    this.boxes.delete(id);
  }
}
