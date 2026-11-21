import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { toAppError, type ComposioStatus, type McpServerView, type SkillView, type PullRequestView, type SubscriptionView } from "@dorks/shared";
import type { DorksClient, ConnectionState } from "./client.ts";
import type { EventsState } from "./events.ts";
import type { QueryState, Store } from "./store.ts";
import type { AutomationRunView, AutomationView, BuildView, Dork, RunView, Settings, SnapshotStatus, Usage, GithubRepos, LocalAccess } from "./types.ts";

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

/** Settings with their load status and error, for the connection gate (the data hooks below hide both). */
export function useSettingsState(): QueryState<Settings> {
  return useStore(useDorksClient().settings());
}

/** `undefined` while loading, so a component can tell loading from empty. */
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

/** The "Prepare Boat" build status with its load state; `undefined` data while loading. */
export function useSnapshotState(): QueryState<SnapshotStatus> {
  return useStore(useDorksClient().snapshot());
}

export function useSnapshot(): SnapshotStatus | undefined {
  return useSnapshotState().data;
}

/** Usage of the Claude subscription and the Boat plan; `undefined` while loading. */
export function useUsage(): Usage | undefined {
  return useStore(useDorksClient().usage()).data;
}

/** What the GitHub CLI login can see: its user, organizations and repositories; `undefined` while loading. */
export function useGithubRepos(): GithubRepos | undefined {
  return useStore(useDorksClient().githubRepos()).data;
}

/** The MCP servers from Customize; `undefined` while loading. */
export function useComposio(): ComposioStatus | undefined {
  return useStore(useDorksClient().composio()).data;
}

/** Local access: the switch and the active permissions; `undefined` while loading. */
export function useLocalAccess(): LocalAccess | undefined {
  return useStore(useDorksClient().localAccess()).data;
}

export function useMcpServers(): McpServerView[] | undefined {
  return useStore(useDorksClient().mcpServers()).data;
}

/** The skills from Customize; `undefined` while loading. */
export function useSkills(): SkillView[] | undefined {
  return useStore(useDorksClient().skills()).data;
}

export function useSecretNames(): string[] | undefined {
  return useStore(useDorksClient().secretNames()).data;
}

/** Builds (docs/builds.md); `undefined` while loading. */
export function useBuilds(): BuildView[] | undefined {
  return useStore(useDorksClient().builds()).data;
}

/** `undefined` while loading, `null` when it does not exist. */
export function useBuild(id: string): BuildView | null | undefined {
  return useStore(useDorksClient().build(id)).data;
}

export function useRuns(buildId: string): RunView[] | undefined {
  return useStore(useDorksClient().runs(buildId)).data;
}

/** Automations (docs/automations.md); `undefined` while loading. */
export function useAutomations(): AutomationView[] | undefined {
  return useStore(useDorksClient().automations()).data;
}

/** `undefined` while loading, `null` when it does not exist. */
export function useAutomation(id: string): AutomationView | null | undefined {
  return useStore(useDorksClient().automation(id)).data;
}

export function useAutomationRuns(id: string): AutomationRunView[] | undefined {
  return useStore(useDorksClient().automationRuns(id)).data;
}

/** The session's pull request, live from GitHub: `data` null when it has none; `error` when GitHub could not be read. */
export function usePullRequest(dorkId: string, url?: string): QueryState<PullRequestView | null> {
  return useStore(useDorksClient().pullRequest(dorkId, url));
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
