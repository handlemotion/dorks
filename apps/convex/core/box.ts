// Thin seam over sandbox providers. The Dork lifecycle depends only on this, so provider API details
// stay in their own files under apps/convex/convex/lib.
export interface BoxProvider {
  /** Must be idempotent on `name`: a retry after a crash returns the box it already made instead of leaking a second. */
  createFromSnapshot(snapshotId: string, opts: { name: string; initCommand: string; env: Record<string, string>; generation?: number; boatEnvironment?: string }): Promise<{ id: string }>;
  /** Idempotent: resuming a running box is not an error. Throws BoxNotFoundError if the box no longer exists. */
  resume(boxId: string): Promise<void>;
  /** Idempotent: pausing a paused box is not an error. */
  pause(boxId: string): Promise<void>;
  /** Idempotent: deleting a missing box is not an error. */
  delete(boxId: string): Promise<void>;
}

/** The box no longer exists at the provider (404 / "not found"). Callers use it to drop a stale box id and recreate. */
export class BoxNotFoundError extends Error {
  constructor(message = "box not found") {
    super(message);
    this.name = "BoxNotFoundError";
  }
}

/** Tolerates errors from mocked/foreign providers: matches the class, or an unambiguous "not found" / "no such box" message. */
export function isBoxNotFound(e: unknown): boolean {
  return e instanceof BoxNotFoundError || (e instanceof Error && (e.name === "BoxNotFoundError" || /\b(not found|no such box)\b/i.test(e.message)));
}

/** Used until the selected provider is configured: every call fails with a clear, non-secret message. */
export function unconfiguredBox(message: string): BoxProvider {
  const fail = async () => { throw new Error(message); };
  return { createFromSnapshot: fail, resume: fail, pause: fail, delete: fail };
}

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
      console.log(`[sim box] start bridge: DORK_ID=${e?.DORK_ID} BRIDGE_SECRET=<derived> node infra/bridge-sim/convex-sim.mjs`);
    }
    this.boxes.set(id, { name: opts.name, running: true });
    return { id };
  }
  async resume(id: string) {
    this.calls.push("resume");
    this.maybeFail("resume");
    const b = this.boxes.get(id) ?? (this.lenient ? this.boxes.set(id, { name: id, running: false }).get(id) : undefined);
    if (!b) throw new BoxNotFoundError("no such box");
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
