// Thin seam over sandbox providers. The Dork lifecycle depends only on this, so provider API details
// stay in their own files under apps/server/src/lib.
export interface BoxProvider {
  /** Must be idempotent on `name`: a retry after a crash returns the box it already made instead of leaking a second. */
  createFromSnapshot(
    snapshotId: string,
    opts: { name: string; initCommand: string; env: Record<string, string>; generation?: number; boatEnvironment?: string; machineType?: string },
  ): Promise<{ id: string }>;
  /** Idempotent: resuming a running box is not an error. Throws BoxNotFoundError if the box no longer exists. */
  resume(boxId: string): Promise<void>;
  /** Idempotent: pausing a paused box is not an error. */
  pause(boxId: string): Promise<void>;
  /** Idempotent: deleting a missing box is not an error. */
  delete(boxId: string): Promise<void>;
  /**
   * A fresh, short-lived URL of the box's live desktop, for an iframe. The URL is a
   * bearer credential: never store or log it. Absent when the provider has no desktop.
   */
  desktopUrl?(boxId: string, opts: DesktopOptions): Promise<string>;
  /**
   * Exposes a port of the box at an https URL the owner's running previews (in Artifacts) can frame (docs/boat.md, "Hosted ports"). Idempotent: asking
   * again for a hosted port answers the same URL. The URL is public (no token), so it may be stored. Absent when the provider
   * cannot host ports.
   */
  hostPort?(boxId: string, port: number, opts: HostPortOptions): Promise<{ url: string }>;
}

export type DesktopOptions = { theme: "light" | "dark" };

/** `localhost`: the app listens only on 127.0.0.1 / ::1, so the provider relays the port (an app on 0.0.0.0 must not ask for it). */
export type HostPortOptions = { title?: string; localhost?: boolean };

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
  const fail = async () => {
    throw new Error(message);
  };
  return { createFromSnapshot: fail, resume: fail, pause: fail, delete: fail };
}
