/** True while a process with this pid exists (EPERM means it exists but is not ours to signal). */
export function pidAlive(pid: number, kill: (pid: number, sig: 0) => unknown = process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid from DORKS_PARENT_PID, or undefined when it is unset or not a usable pid. */
export function parentPid(env: Record<string, string | undefined>): number | undefined {
  const raw = env.DORKS_PARENT_PID;
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/**
 * Calls `onGone` once if the supervising process disappears (the desktop shell sets DORKS_PARENT_PID). A server whose parent was
 * killed would otherwise keep running, and keep timers firing against sandboxes, with nobody to talk to it.
 */
export function watchParent(pid: number, onGone: () => void, everyMs = 2_000, alive: (pid: number) => boolean = pidAlive): () => void {
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
