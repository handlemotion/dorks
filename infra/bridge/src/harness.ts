import type { Engine } from "@dorks/shared";
import type { Identity } from "./runas";
import type { Log, Redactor } from "./redact";

/**
 * The adapter seam between the bridge and an agent harness (the program that gives the model its tools and runs its loop). The bridge
 * only ever talks to a harness through this; each engine (`@dorks/shared` `engine`) has one implementation:
 *   claude    claude.ts    `claude -p` over stream-json on stdin/stdout; forwards Claude's own stream-json (the backend reads it as is)
 *   opencode  opencode.ts  `opencode serve` over HTTP + SSE; translates its events into neutral agent events (`@dorks/shared` agent.ts)
 */
export interface Harness {
  readonly engine: Engine;
  readonly pid: number | undefined;
  /** The harness's session id, once known (the one to resume). */
  readonly sessionId: string | null;
  /** False once it exited or is being stopped. */
  readonly alive: boolean;
  /** Writes one user turn. Resolves once the harness has it; rejects if it is not running. */
  sendUserMessage(text: string): Promise<void>;
  /** Stops the current turn, not the session; queued messages still run. */
  interrupt(): Promise<void>;
  /** Resolves when the agent is between turns, or after `ms`. Returns whether it is idle. */
  waitIdle(ms: number): Promise<boolean>;
  /** Ends the harness process. Does not report `onExit`. */
  stop(graceMs?: number): Promise<void>;
  /** Files holding the session that must be on disk before the box pauses. */
  sessionFiles(): string[];
}

/** What every harness gets from the bridge. */
export interface HarnessOptions {
  cwd: string;
  /** Final child env (already filtered + merged). */
  env: NodeJS.ProcessEnv;
  /** Resume this session; the bridge only passes one the engine's `hasSession` found on this box. */
  resumeSessionId: string | null;
  runAs?: Identity | null;
  redactor: Redactor;
  log: Log;
  /** One event payload for the pipeline: a Claude stream-json line or a neutral agent event (`toRaw`). */
  onRaw: (raw: unknown) => void;
  /** Not called when the exit was requested through {@link Harness.stop}. */
  onExit: (info: ExitInfo) => void;
}

export interface ExitInfo {
  code: number | null;
  stderrTail: string;
  /** Started to resume a session, the harness said it has no such session, and nothing was forwarded for this run. */
  resumeMissing: boolean;
  /** Messages written to the harness that it never got to answer (for a resend on a fresh session). */
  pending: string[];
}
