import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** The chat the Chat tab shows: a session's id, or null for a new chat. The sidebar picks it. */
const Ctx = createContext<{ dorkId: string | null; setDorkId: (id: string | null) => void } | null>(null);

export function CurrentChatProvider({ children }: { children: ReactNode }) {
  const [dorkId, setDorkId] = useState<string | null>(null);
  const value = useMemo(() => ({ dorkId, setDorkId }), [dorkId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrentChat() {
  const state = useContext(Ctx);
  if (!state) throw new Error("useCurrentChat must be used inside <CurrentChatProvider>");
  return state;
}
