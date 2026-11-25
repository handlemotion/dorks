/** "12s", "2m 14s", "1h 3m": how long a turn worked (as the desktop says it). */
export function workedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "Good morning", by the phone's clock. */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(at: number | string | null | undefined, now = Date.now()): string | undefined {
  if (at === null || at === undefined) return undefined;
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return undefined;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
