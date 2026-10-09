import { rpcCall } from "./rpc";

// `dorks hook <event>`: the command Claude Code runs for each hook (bridge-written settings, see hooks.ts). It forwards the hook's JSON
// input to the bridge over the local RPC and prints the bridge's answer, if any, as the hook's JSON output.
//
// It fails open. A hook that errors, hangs or prints garbage can wedge or derail the agent, so any problem (no bridge, a slow bridge,
// unreadable input, an exception) ends in exit 0 and no output, which Claude Code reads as "no opinion".

/** The CLI name of each hook, its RPC method, and how long Claude Code may wait for it (seconds; the RPC gives up a little earlier). */
export const HOOK_EVENTS = {
  stop: { claude: "Stop", method: "hook.stop", timeoutS: 30 },
  "post-tool-use": { claude: "PostToolUse", method: "hook.postToolUse", timeoutS: 15 },
  "session-start": { claude: "SessionStart", method: "hook.sessionStart", timeoutS: 10 },
} as const;
export type HookEvent = keyof typeof HOOK_EVENTS;

const isEvent = (s: string | undefined): s is HookEvent => s !== undefined && Object.hasOwn(HOOK_EVENTS, s);

export async function runHook(event: string | undefined, env: NodeJS.ProcessEnv, readInput: () => Promise<string>, out: (s: string) => void): Promise<number> {
  const sock = env.DORKS_SOCK;
  if (!isEvent(event) || !sock) return 0;
  try {
    const input = JSON.parse(await readInput());
    const reply = await rpcCall(sock, HOOK_EVENTS[event].method, input, (HOOK_EVENTS[event].timeoutS - 2) * 1000);
    if (reply && typeof reply === "object") out(JSON.stringify(reply) + "\n");
  } catch {
    /* fail open */
  }
  return 0;
}
