import { createClient } from "@dorks/client";
import { DorksProvider, useConnection } from "@dorks/client/react";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { cloud, type Mac } from "./cloud";
import { CLOUD_URL } from "./config";

const SELECTED = "dorks.mac";

interface MacsState {
  token: string;
  /** `undefined` until the first read. */
  macs: Mac[] | undefined;
  /** The Mac the app talks to: the one picked last, else the first. */
  mac: Mac | undefined;
  error: string | undefined;
  select: (id: string) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<MacsState | null>(null);

export function useMacs(): MacsState {
  const state = useContext(Ctx);
  if (!state) throw new Error("useMacs must be used inside <MacsProvider>");
  return state;
}

/** The account's paired Macs, read again whenever the app comes to the front, and the one picked (remembered in the keychain). */
export function MacsProvider({ token, children }: { token: string; children: ReactNode }) {
  const [macs, setMacs] = useState<Mac[]>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    void SecureStore.getItemAsync(SELECTED).then(setPicked);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMacs(await cloud.macs(token));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    // Another Mac may come online or go away meanwhile; the picked one's state also follows its live stream (LiveSync below).
    const timer = setInterval(() => AppState.currentState === "active" && void refresh(), 30_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [refresh]);

  const select = useCallback((id: string) => {
    setPicked(id);
    void SecureStore.setItemAsync(SELECTED, id);
  }, []);

  const mac = macs?.find((m) => m.id === picked) ?? macs?.[0];
  const value = useMemo(() => ({ token, macs, mac, error, select, refresh }), [token, macs, mac, error, select, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The UI API of the picked Mac, through the relay. `expo/fetch` streams response bodies, which the live stream (SSE) needs. */
export const macBaseUrl = (macId: string) => `${CLOUD_URL}/v1/macs/${encodeURIComponent(macId)}`;

/** One @dorks/client per Mac and session; its children only render when a Mac is picked. */
export function MacClientProvider({ children }: { children: ReactNode }) {
  const { mac, token } = useMacs();
  const macId = mac?.id;
  const client = useMemo(() => (macId ? createClient({ baseUrl: macBaseUrl(macId), token, fetch: expoFetch as unknown as typeof fetch }) : null), [macId, token]);
  if (!client) return children;
  // Keyed by Mac: switching Macs starts the pages (and the open chat) afresh.
  return (
    <DorksProvider key={macId} client={client}>
      <LiveSync />
      {children}
    </DorksProvider>
  );
}

/** Reads the Macs again when the picked Mac's live stream connects or drops, so its online label never lags the stream. */
function LiveSync() {
  const { live } = useConnection();
  const { refresh } = useMacs();
  useEffect(() => {
    if (live === "live" || live === "offline") void refresh();
  }, [live, refresh]);
  return null;
}
