import type { App } from "../app";
import { localOwner, type Actor } from "./team";

// Live presence (docs/cloud.md, "Presence"): who is looking at which dork right now. In memory only: a restart forgets it, and the
// clients tell it again. Each browser tab or phone is a client with its own id; it opens the live stream with `?client=<id>` and says
// which dork it shows with `POST /api/presence`. A client counts while its live stream is open (or for GRACE_MS after it said where
// it is, so a tab that posts before its stream connects still shows). Everyone gets `{t: "presence", dorkId, viewers}` on the live
// stream whenever a dork's viewers change, and the current viewers of every dork right after `hello`.

export type Viewer = { id: string; name: string };

const GRACE_MS = 60_000;
const CLIENT = /^[A-Za-z0-9_-]{8,64}$/;

interface Entry {
  viewer: Viewer;
  dorkId: string | null;
  streams: number;
  seenAt: number;
}

const rooms = new WeakMap<App, Map<string, Entry>>();
const entries = (app: App) => {
  let m = rooms.get(app);
  if (!m) rooms.set(app, (m = new Map()));
  return m;
};

/** How an actor shows in presence. The local owner (and the single-owner phone) by the name the cloud gave, else "Owner". */
export function viewerOf(app: App, actor: Actor): Viewer {
  if (actor.kind === "member") return { id: actor.member.id, name: actor.member.name || actor.member.email || "Someone" };
  const owner = localOwner(app);
  return owner ? { id: owner.id, name: owner.name } : { id: "owner", name: "Owner" };
}

export const validClient = (client: unknown): client is string => typeof client === "string" && CLIENT.test(client);

// One person's client ids live under their own key, so nobody can move another person's presence.
const keyOf = (viewer: Viewer, client: string) => `${viewer.id}\u0000${client}`;

export function viewersOf(app: App, dorkId: string): Viewer[] {
  const seen = new Map<string, Viewer>();
  const now = app.now();
  for (const e of entries(app).values()) if (e.dorkId === dorkId && (e.streams > 0 || now - e.seenAt < GRACE_MS)) seen.set(e.viewer.id, e.viewer);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every dork somebody is looking at, for a new live stream. */
export function allPresence(app: App): { dorkId: string; viewers: Viewer[] }[] {
  const ids = new Set<string>();
  for (const e of entries(app).values()) if (e.dorkId) ids.add(e.dorkId);
  return [...ids].map((dorkId) => ({ dorkId, viewers: viewersOf(app, dorkId) })).filter((p) => p.viewers.length);
}

const announce = (app: App, ...dorkIds: (string | null)[]) => {
  for (const dorkId of new Set(dorkIds)) if (dorkId) app.hub.emit({ t: "presence", dorkId, viewers: viewersOf(app, dorkId) });
};

function prune(app: App) {
  const now = app.now();
  const gone: (string | null)[] = [];
  for (const [k, e] of entries(app)) {
    if (e.streams === 0 && now - e.seenAt >= GRACE_MS) {
      entries(app).delete(k);
      gone.push(e.dorkId);
    }
  }
  announce(app, ...gone);
}

/** A client's live stream opened; the returned function closes it (the client left when it was its last stream). */
export function openStream(app: App, actor: Actor, client: string): () => void {
  prune(app);
  const viewer = viewerOf(app, actor);
  const k = keyOf(viewer, client);
  const e = entries(app).get(k) ?? { viewer, dorkId: null, streams: 0, seenAt: app.now() };
  e.streams++;
  entries(app).set(k, e);
  return () => {
    e.streams--;
    if (e.streams > 0) return;
    entries(app).delete(k);
    announce(app, e.dorkId);
  };
}

/** The client now shows `dorkId` (null: no dork). */
export function setViewing(app: App, actor: Actor, client: string, dorkId: string | null) {
  prune(app);
  const viewer = viewerOf(app, actor);
  const k = keyOf(viewer, client);
  const e = entries(app).get(k) ?? { viewer, dorkId: null, streams: 0, seenAt: app.now() };
  const was = e.dorkId;
  e.dorkId = dorkId;
  e.seenAt = app.now();
  entries(app).set(k, e);
  if (was !== dorkId) announce(app, was, dorkId);
}
