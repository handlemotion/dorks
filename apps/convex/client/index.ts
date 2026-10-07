// Shared by web (DOM) and Expo (native): the whole "live transcript" is one paginated, reactive query folded through the
// existing pure `fold`. No sockets, tickets, `after=` cursors or gap handling.
import { emptyView, fold, type ClientEvent, type DorkView } from "@dorks/shared";
import { usePaginatedQuery, useQuery } from "convex/react";
import { useMemo } from "react";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";

export { api };
export type { Id };

export function useDorkEvents(dorkId: Id<"dorks">, pageSize = 40): { view: DorkView; canLoadMore: boolean; loadMore: () => void; loading: boolean } {
  const { results, status, loadMore } = usePaginatedQuery(api.events.list, { dorkId }, { initialNumItems: pageSize });
  const view = useMemo(() => [...(results as ClientEvent[])].reverse().reduce(fold, emptyView()), [results]); // newest-first pages -> oldest-first fold
  return { view, canLoadMore: status === "CanLoadMore", loadMore: () => loadMore(pageSize), loading: status === "LoadingFirstPage" };
}

export const useDork = (dorkId: Id<"dorks">) => useQuery(api.dorks.get, { dorkId });
export const useDorks = (archived = false) => useQuery(api.dorks.list, { archived });
export const errorCode = (e: unknown) => (e as { data?: { code?: string; message?: string } })?.data?.code ?? "failed";
export const errorMessage = (e: unknown) => (e as { data?: { message?: string } })?.data?.message ?? "Something went wrong";
