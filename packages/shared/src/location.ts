// Where a dork runs (docs/local-dorks.md): in a cloud sandbox (Boat, the default), or on the owner's own computer, with the agent CLIs
// installed there working in a git worktree under the server's data directory. Stored per dork; the box provider is picked from it.

export const DORK_LOCATIONS = ["cloud", "local"] as const;
export type DorkLocation = (typeof DORK_LOCATIONS)[number];

export const isDorkLocation = (v: unknown): v is DorkLocation => typeof v === "string" && (DORK_LOCATIONS as readonly string[]).includes(v);

/**
 * Whether this server can run local dorks for the asking client (`GET /api/settings` `local`): only the owner on this computer, never a
 * relayed client (the phone, a teammate), and only on a server that runs on the owner's computer. `reason` says why not, in plain words.
 */
export interface LocalAvailability {
  available: boolean;
  reason?: string;
}
