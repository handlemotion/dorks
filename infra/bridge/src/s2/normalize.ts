import { createNormalizer } from "@dorks/core/normalize";
import { errorEvent, type ClientEventBody, type FromBridge } from "@dorks/shared";

// Cloud sessions (S2Transport): the bridge turns the agent's stream into the client events the transcript holds, as the server does
// for a Mac (apps/server/src/services/bridge.ts, applyEvent): the same normalizer (@dorks/core), the turn's final message named on
// its turn_complete, a turn the user stopped marked `stopped`. What the server would have written to the dork row instead (the
// session id, turn boundaries, the preview) comes out as state frames for the Worker.

/** What the Worker hears about on `POST /v1/bridge/:id/state`: the bridge's control frames plus these, derived from the stream. */
export type StateFrame =
  | Exclude<FromBridge, { t: "event" }>
  | { t: "session"; sessionId: string; model?: string }
  | { t: "turn_started" }
  | { t: "turn_idle" }
  /** The last assistant message's start, for the session list. */
  | { t: "preview"; text: string };

export class SessionNormalizer {
  private normalize = createNormalizer();
  private finalMsgId = "";
  /** Set when an interrupt is delivered: the turn it ends is `stopped`, not failed. */
  interruptRequested = false;

  /** One agent line: its client events (in order) and the state frames it implies. */
  line(raw: unknown): { events: ClientEventBody[]; state: StateFrame[] } {
    const events: ClientEventBody[] = [];
    const state: StateFrame[] = [];
    let stopped = false;
    for (const n of this.normalize(raw)) {
      if (n.kind === "session") state.push({ t: "session", sessionId: n.sessionId, ...(n.model ? { model: n.model } : {}) });
      else if (n.kind === "idle") state.push({ t: "turn_idle" });
      else if (n.kind === "running") state.push({ t: "turn_started" });
      else {
        let body = n.body;
        if (body.type === "assistant_message") this.finalMsgId = body.messageId;
        if (body.type === "tool_use") this.finalMsgId = "";
        if (body.type === "turn_complete") {
          stopped = this.interruptRequested && body.outcome === "failed";
          const outcome = stopped ? "stopped" : body.outcome;
          body = { ...body, outcome, ...(outcome === "done" && this.finalMsgId ? { finalMessageId: this.finalMsgId } : {}) };
          this.finalMsgId = "";
          this.interruptRequested = false;
        }
        if (stopped && body.type === "error" && body.error?.code === "turn_failed") continue;
        events.push(body);
        if (body.type === "assistant_message") state.push({ t: "preview", text: body.text.slice(0, 140) });
      }
    }
    return { events, state };
  }

  /** The client events the server writes for a control frame (the bridge's stderr tail is already scrubbed of known secrets). */
  static noteFor(frame: Exclude<FromBridge, { t: "event" }>): ClientEventBody[] {
    if (frame.t === "agent_exited") {
      const why = frame.stderrTail.trim().split("\n").pop()?.trim().slice(0, 200);
      return [{ type: "agent_exited", message: `agent exited (code ${frame.code ?? "?"})${why ? `: ${why}` : ""}` }];
    }
    if (frame.t === "codex_issue") return [errorEvent({ code: "failed", message: frame.message })];
    return [];
  }
}
