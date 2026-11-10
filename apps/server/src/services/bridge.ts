import { errorEvent, fromBridge, type ClientEventBody, type CommandFrame, type SubscriptionView, type ToBridge } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { createNormalizer } from "../core/normalize";
import { getDork, openCommands, runtimeOf, type DorkRow } from "../data";
import { update } from "../db";
import { append, bridgeSeen, dispatch, enqueueConfigure, finishPause, patchDork } from "../lifecycle/dispatch";
import { opFailed } from "../lifecycle/lifecycle";
import { claudeToken, cliSecrets, githubToken } from "./settings";
import * as subs from "./subscriptions";

// What the in-box bridge may do (docs/architecture.md, "Bridge protocol"). These are the bodies of the WebSocket rpc ops and of the
// commands snapshot; http/bridgeWs.ts authenticates the socket (per-dork HMAC) before any of them runs.

// Per-call limits: one push is one transaction, and a hostile or buggy bridge must not be able to fill it.
export const MAX_FRAMES_PER_PUSH = 500;
export const MAX_EVENT_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** The dork a bridge socket speaks for, or `forbidden` if it is gone. */
export function bridgeDork(app: App, dorkId: string): DorkRow {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return fail("forbidden", "forbidden");
  return dork;
}

export function connect(app: App, dorkId: string): { afterBridgeSeq: number } {
  return app.db.tx(() => {
    const dork = bridgeDork(app, dorkId);
    // A bridge that connects while we believe the box is asleep must not wake anything.
    if (dork.state === "sleeping") fail("sleeping", "sleeping");
    bridgeSeen(app, dork);
    enqueueConfigure(app, dorkId);
    return { afterBridgeSeq: runtimeOf(app.db, dorkId).bridgeSeq };
  });
}

export function heartbeat(app: App, dorkId: string) {
  app.db.tx(() => bridgeSeen(app, bridgeDork(app, dorkId))); // back after a blip while working/idle cancels the watchdog the loss armed
}

export type CommandEntry = { cid: string; frame: CommandFrame };

/** The snapshot of commands the bridge still owes an ack for, in the shape it executes. Pure read. */
export function commandsFor(app: App, dorkId: string): CommandEntry[] {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting || dork.state === "sleeping") return [];
  // Before `ready` the agent is not up. And once the box call of a pause is in flight (or was cancelled but still lands), a
  // delivered message could be acked and then lost with the box: hold it back, the re-wake after the pause delivers it.
  const rt = runtimeOf(app.db, dorkId);
  const deliverMessages = (dork.state === "working" || dork.state === "idle") && (!rt.pause || rt.pause.phase === "flushing");
  const open = openCommands(app.db, dorkId);
  // User messages always go first: no notify is emitted while one is unacked. A notify that arrived mid-turn stays held
  // (`released` false) until the machine's release_notify, so a turn is never interrupted by an autonomous event.
  const userPending = open.some((c) => c.kind === "user_message");
  const out: CommandEntry[] = [];
  for (const c of open) {
    if (c.kind === "user_message") {
      if (deliverMessages) out.push({ cid: c.cid, frame: { t: "user_message", id: c.cid, text: c.text! } });
    } else if (c.kind === "notify") {
      if (deliverMessages && !userPending && (dork.state === "idle" || c.released))
        out.push({ cid: c.cid, frame: { t: "notify", id: c.cid, text: c.text!, kinds: c.meta!.kinds as never, prs: c.meta!.prs } });
    } else if (c.kind === "configure") out.push({ cid: c.cid, frame: { t: "fetch_configure" } });
    else out.push({ cid: c.cid, frame: { t: c.kind } });
  }
  return out;
}

export const subscriptionsFor = (app: App, dorkId: string): SubscriptionView[] => subs.liveSubscriptionViews(app, dorkId);

/**
 * Bridge -> server frames, batched. Events must arrive numbered exactly `bridgeSeq + 1`, `+ 2`, ... (anything `<= bridgeSeq` is a
 * replay and is skipped). If the call contains a gap, NOTHING in it is applied and the result is `{ ok: false, expectedBseq }`
 * (`bridgeSeq + 1`): the bridge must resend everything from its event `expectedBseq` on. Otherwise the result is `{ ok: true }`.
 * Too many frames or an oversized event reject the whole call (`too_many_frames` / `event_too_large`).
 */
export function push(app: App, dorkId: string, frames: unknown[]): { ok: true } | { ok: false; expectedBseq: number } {
  if (!Array.isArray(frames)) fail("invalid", "frames must be an array");
  if (frames.length > MAX_FRAMES_PER_PUSH) fail("too_many_frames", `at most ${MAX_FRAMES_PER_PUSH} frames per push`);
  for (const raw of frames) {
    const payload = (raw as { raw?: unknown } | null)?.raw;
    if (payload !== undefined && encoder.encode(JSON.stringify(payload)).length > MAX_EVENT_BYTES) fail("event_too_large", `an event exceeds ${MAX_EVENT_BYTES} bytes`);
  }
  return app.db.tx(() => {
    const dork = bridgeDork(app, dorkId);
    bridgeSeen(app, dork); // liveness counts even when the batch is refused below
    const rt = runtimeOf(app.db, dorkId);
    let { bridgeSeq, streamMsgId } = rt;

    // Validate the whole batch before applying any of it: events must continue the stored numbering exactly (frames already
    // stored are skipped as replays). A gap refuses the call atomically, so the bridge can resend everything after its last
    // confirmed event without any frame (an `agent_exited`, say) being applied twice.
    const parsedFrames = frames.flatMap((raw) => {
      const parsed = fromBridge.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    let next = bridgeSeq + 1;
    for (const f of parsedFrames) {
      if (f.t !== "event" || f.bseq < next) continue;
      if (f.bseq !== next) return { ok: false as const, expectedBseq: bridgeSeq + 1 };
      next++;
    }
    // The normalizer is stateful (in-flight message id) but a transaction is not: seed it from the last batch.
    const normalize = createNormalizer();
    if (streamMsgId) normalize({ type: "stream_event", event: { type: "message_start", message: { id: streamMsgId } } });

    const pending: ClientEventBody[] = [];
    const flush = () => {
      if (pending.length) append(app, dorkId, ...pending.splice(0));
    };
    let preview: string | undefined;
    let touched = false;

    for (const f of parsedFrames) {
      switch (f.t) {
        case "codex_models":
          if (dork.provider === "codex") patchDork(app, dorkId, { codexModelChoices: f.models });
          break;
        case "codex_issue":
          if (dork.provider === "codex") append(app, dorkId, errorEvent({ code: "failed", message: f.message }));
          break;
        case "codex_login":
          break; // legacy per-box sign-in: Codex signs in through a Boat environment now
        case "event": {
          if (f.bseq <= bridgeSeq) break; // replay overlap after a reconnect
          bridgeSeq = f.bseq;
          const r = f.raw as { type?: string; event?: { type?: string; message?: { id?: string } } };
          if (r?.type === "stream_event" && r.event?.type === "message_start") streamMsgId = r.event.message?.id ?? "";
          for (const n of normalize(f.raw)) {
            if (n.kind === "event") {
              pending.push(n.body);
              if (n.body.type === "assistant_message") preview = n.body.text.slice(0, 140);
              if (n.body.type === "turn_complete") touched = true;
            } else if (n.kind === "session") {
              patchDork(app, dorkId, dork.provider === "codex" ? { codexThreadId: n.sessionId } : { claudeSessionId: n.sessionId });
            } else {
              flush();
              dispatch(app, dorkId, { t: "turn_idle" });
            }
          }
          break;
        }
        case "ready":
          flush();
          if (dork.provider === "codex") patchDork(app, dorkId, { codexModelChoices: undefined });
          dispatch(app, dorkId, { t: "agent_ready" });
          break;
        case "ack": {
          const c = openCommands(app.db, dorkId).find((x) => x.cid === f.id);
          if (!c) break;
          if (c.kind === "user_message" || c.kind === "notify") update(app.db, "commands", { id: c.id }, { acked: true });
          else app.db.run("DELETE FROM commands WHERE id = ?", c.id);
          touch(app, { t: "commands", dorkId });
          break;
        }
        case "agent_exited":
          flush();
          append(app, dorkId, { type: "agent_exited", message: `agent exited (code ${f.code ?? "?"})` });
          console.error("agent exited", dorkId, f.code); // stderr tail is never logged: it can echo env
          dispatch(app, dorkId, { t: "agent_exited" });
          break;
        case "flushed":
          finishPause(app, dorkId, f.cid);
          break;
      }
    }
    flush();
    update(app.db, "dork_runtime", { dorkId }, { bridgeSeq, streamMsgId });
    if (preview !== undefined || touched) patchDork(app, dorkId, { ...(preview !== undefined ? { preview } : {}), lastActivityAt: app.now() });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------- PR subscriptions (docs/autonomy.md)
// The gh shim / hooks / `dorks pr` CLI in the box call these through the bridge. PRs the poller sees change reach the agent as `notify` frames.

export function subscribePr(app: App, dorkId: string, repo: string, number: number, source: "auto" | "agent") {
  if (source !== "auto" && source !== "agent") fail("invalid", "bad source");
  app.db.tx(() => void subs.subscribe(app, bridgeDork(app, dorkId), repo, number, source));
}

export function unsubscribePr(app: App, dorkId: string, repo: string, number: number) {
  app.db.tx(() => {
    bridgeDork(app, dorkId);
    subs.unsubscribe(app, dorkId, repo, number);
  });
}

// ---------------------------------------------------------------- secrets (async: decryption never happens inside a transaction)
/** Secrets are only minted for a dork whose box should be up and which the user has not archived. */
const TOKEN_STATES = ["creating", "waking", "working", "idle"];
export const mayMintSecrets = (dork: Pick<DorkRow, "state" | "archived">) => !dork.archived && TOKEN_STATES.includes(dork.state);

class OnboardingError extends Error {}

/** `configure` was refused. If the dork was archived while still booting, finish the boot handshake so the box is paused, not left running. */
function settleRefused(app: App, dorkId: string) {
  app.db.tx(() => {
    const dork = getDork(app.db, dorkId);
    if (dork && !dork.deleting && dork.archived && (dork.state === "creating" || dork.state === "waking")) dispatch(app, dorkId, { t: "agent_ready" });
  });
}

/** Returns the `configure` frame (Claude token + CLI secrets + GitHub token) straight to the authenticated bridge: never stored. */
export async function configure(app: App, dorkId: string): Promise<ToBridge | null> {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) fail("forbidden", "forbidden");
  if (!mayMintSecrets(dork)) {
    console.error("configure refused", dorkId);
    settleRefused(app, dorkId);
    return null;
  }
  try {
    const sim = app.cfg.boxProvider === "sim";
    const claude = dork.provider === "claude" ? await claudeToken(app) : undefined;
    if (dork.provider === "claude" && !claude) throw new OnboardingError("Claude token not set");
    const gh = (await githubToken(app)) ?? (sim ? "sim-github-token" : undefined);
    if (!gh) throw new OnboardingError("GitHub token not set");
    const secrets = await cliSecrets(app);
    return {
      t: "configure",
      provider: dork.provider,
      ...(dork.provider === "codex" ? { codexAuthSource: "boat" as const, codexModel: dork.codexModel } : {}),
      env: { ...secrets, ...(claude ? { CLAUDE_CODE_OAUTH_TOKEN: claude } : {}) },
      ghToken: gh,
      repo: { fullName: dork.repo, branch: dork.branch },
      resumeSessionId: (dork.provider === "codex" ? dork.codexThreadId : dork.claudeSessionId) ?? null,
    };
  } catch (e) {
    const message = e instanceof OnboardingError ? e.message : "could not configure the sandbox";
    console.error("configure failed", dorkId, e instanceof OnboardingError ? e.message : "unexpected");
    app.db.tx(() => opFailed(app, dorkId, message));
    return null;
  }
}

/** The stored GitHub token, for the bridge's refresh path. Same gating as `configure`. */
export async function ghToken(app: App, dorkId: string): Promise<{ token: string } | null> {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) fail("forbidden", "forbidden");
  if (!mayMintSecrets(dork)) return null;
  const token = (await githubToken(app)) ?? (app.cfg.boxProvider === "sim" ? "sim-github-token" : undefined);
  return token ? { token } : null;
}
