import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { toAppError, type SubscriptionView } from "@dorks/shared";
import type { DorksClient, ConnectionState } from "./client.ts";
import type { EventsState } from "./events.ts";
import type { Store } from "./store.ts";
import type { Dork, Settings } from "./types.ts";

const Ctx = createContext<DorksClient | null>(null);

/** Opens the live stream while mounted. The client is created by the app (it owns the URL and token). */
export function DorksProvider({ client, children }: { client: DorksClient; children: ReactNode }) {
  useEffect(() => {
    client.start();
    return () => client.close();
  }, [client]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useDorksClient(): DorksClient {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDorksClient must be used inside <DorksProvider>");
  return c;
}

const useStore = <S,>(store: Store<S>): S => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

/** Live connection state: stream status and whether the owner token was rejected. */
export function useConnection(): ConnectionState {
  return useStore(useDorksClient().connectionStore);
}

/** `undefined` while loading, like the Convex hooks this replaces. Use the `*State` hooks when you need the error. */
export function useDorks(archived = false): Dork[] | undefined {
  return useStore(useDorksClient().dorks(archived)).data;
}

/** `undefined` while loading, `null` when it does not exist. */
export function useDork(dorkId: string): Dork | null | undefined {
  return useStore(useDorksClient().dork(dorkId)).data;
}

export function useSettings(): Settings | undefined {
  return useStore(useDorksClient().settings()).data;
}

export function useSecretNames(): string[] | undefined {
  return useStore(useDorksClient().secretNames()).data;
}

export function useSubscriptions(dorkId: string): SubscriptionView[] | undefined {
  return useStore(useDorksClient().subscriptions(dorkId)).data;
}

export function useDorkEvents(dorkId: string): EventsState & { loadMore: () => void; send: (text: string) => Promise<void> } {
  const feed = useDorksClient().events(dorkId);
  const state = useStore(feed);
  return { ...state, loadMore: () => feed.loadMore(), send: (text) => feed.send(text) };
}

export const errorMessage = (e: unknown) => toAppError(e).message;
export const errorCode = (e: unknown) => toAppError(e).code;
