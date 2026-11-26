// Opt-in: a real bridge process (the built bundle, DORKS_TRANSPORT=s2) against REAL s2 (a dev basin) through a stand-in Worker,
// with the real `claude` CLI when CLAUDE_CODE_OAUTH_TOKEN is set (else the fake one). Skipped without S2_ACCESS_TOKEN and S2_BASIN.
//   doppler run -p dorks-cloud -c dev -- sh -c 'CLAUDE_CODE_OAUTH_TOKEN=$(doppler secrets get CLAUDE_CODE_OAUTH_TOKEN --plain -p dorks -c dev_live) \
//     pnpm --filter @dorks/bridge test s2-live'
// It proves, on real s2: the fence (a killed bridge's successor fences it out: 412), exactly-once events across two kill -9s,
// commands at least once with duplicates (a retried cid) skipped and each echoed once, and the s2 token renewed through the Worker.
// It creates one throwaway session's streams and tokens under orgs/e2e-bridge/ and deletes them at the end.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { S2, S2Error } from "../src/s2/s2";
import { header } from "../src/s2/records";
import { StandInWorker } from "./fixtures/s2-worker";
import { builtCli, FAKE_CLAUDE, sleep, tmp, waitFor } from "./helpers";

const token = process.env.S2_ACCESS_TOKEN;
const basin = process.env.S2_BASIN;
const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const SECRET = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

describe.skipIf(!token || !basin)("a real bridge on real s2", () => {
  const session = `sess-${Date.now().toString(36)}`;
  const admin = new S2({ token: token!, basin: basin! });
  // A throwaway KEK: the dev basin is aegis-256, so every append and read needs the session's key.
  const worker = new StandInWorker({ admin, org: "e2e-bridge", session, secret: SECRET, kek: SECRET.slice(0, 32), tokenTtlMs: 120_000, configureOnConnect: true });
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  afterAll(async () => {
    if (process.env.S2_LIVE_LOGS) console.log(logs.join(""));
    for (const c of children) c.kill("SIGKILL");
    await worker.cleanup();
  });

  const home = tmp("s2-home-");
  const state = tmp("s2-state-");
  let url = "";
  const startBridge = () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      DORK_ID: session,
      BRIDGE_SECRET: SECRET,
      DORKS_TRANSPORT: "s2",
      DORKS_WORKER_URL: url,
      DORKS_STATE_DIR: state,
      DORKS_SOCK_DIR: state,
      DORKS_WORKDIR: join(home, "work"),
      CLAUDE_BIN: claudeToken ? (process.env.CLAUDE_BIN ?? "claude") : FAKE_CLAUDE,
      DORKS_CLAUDE_ARGS: claudeToken ? "--model haiku" : "",
      FAKE_CLAUDE_DELTAS: "5",
    };
    const child = spawn(process.execPath, [builtCli()], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => logs.push(String(d)));
    child.stderr!.on("data", (d) => logs.push(String(d)));
    children.push(child);
    return child;
  };
  const items = () => worker.transcript();
  const echoes = async () => (await items()).flatMap((i) => (i.kind === "command" ? [i.cid] : []));
  const events = async () => (await items()).flatMap((i) => (i.kind === "event" ? (JSON.parse(i.body) as { type: string; [k: string]: unknown }[]) : []));
  const turnsDone = async () => (await events()).filter((e) => e.type === "turn_complete").length;
  const kill9 = async (c: ChildProcess) => {
    c.kill("SIGKILL");
    await new Promise((r) => c.once("exit", r));
  };

  it("runs turns, survives two kill -9s with every event written once and every command echoed once", { timeout: 300_000 }, async () => {
    mkdirSync(join(home, "work"), { recursive: true });
    url = await worker.listen();
    worker.configure = { t: "configure", env: claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}, ghToken: "unused", repo: null, resumeSessionId: null };
    await worker.open();
    await worker.sendCommand("msg-0001", { t: "user_message", id: "msg-0001", text: "Reply with exactly the word: pong" });
    await worker.sendCommand("msg-0001", { t: "user_message", id: "msg-0001", text: "Reply with exactly the word: pong" }); // a retried append

    // Bridge A: configure, the first turn.
    const a = startBridge();
    await waitFor(async () => (await turnsDone()) >= 1, "first turn", 120_000);
    const first = await events();
    expect(first.find((e) => e.type === "turn_complete")).toMatchObject({ outcome: "done", finalMessageId: expect.any(String) });
    if (claudeToken)
      expect(
        first
          .filter((e) => e.type === "assistant_message")
          .map((e) => String(e.text).toLowerCase())
          .join(" "),
      ).toContain("pong");
    const sessionFrame = await waitFor(() => worker.state.find((f) => f.t === "session") as { sessionId: string } | undefined, "session id reported");
    await waitFor(() => worker.state.some((f) => f.t === "turn_idle"), "turn_idle reported");
    await waitFor(() => worker.tokens > worker.connects, "the s2 token renewed through the Worker", 30_000);

    // kill -9 A. A message arrives while no bridge runs; bridge B fences A out and delivers it on the same Claude session.
    await kill9(a);
    worker.configure = { ...worker.configure, resumeSessionId: sessionFrame.sessionId };
    await worker.sendCommand("msg-0002", { t: "user_message", id: "msg-0002", text: "Reply with exactly the word: ping" });
    const b = startBridge();
    await waitFor(async () => (await turnsDone()) >= 2, "second turn on bridge B", 120_000);
    const stale = await admin
      .withKey((await worker.key()) ?? undefined)
      .append(
        worker.streams.events,
        [
          {
            headers: [
              ["k", "ev"],
              ["b", "999999"],
              ["c", "0"],
            ],
            body: "[]",
          },
        ],
        { fencingToken: worker.fences[0] },
      )
      .then(
        () => "appended",
        (e) => (e instanceof S2Error ? `${e.status} ${Object.keys(e.body ?? {})[0]}` : String(e)),
      );
    expect(stale).toBe("412 fencing_token_mismatch");

    // kill -9 B right after it acked msg-0003 (mid-turn), then bridge C: msg-0003 is not delivered again.
    await worker.sendCommand("msg-0003", { t: "user_message", id: "msg-0003", text: "Count from 1 to 30, one number per line." });
    await waitFor(async () => (await echoes()).includes("msg-0003"), "msg-0003 acked", 60_000);
    await kill9(b);
    startBridge();
    await waitFor(() => worker.connects >= 3, "bridge C connected", 30_000);
    await waitFor(async () => (await echoes()).filter((c) => c.startsWith("cfg-")).length >= 3, "bridge C configured", 60_000);
    await sleep(3000);

    const cids = await echoes();
    const count = (id: string) => cids.filter((c) => c === id).length;
    expect([count("msg-0001"), count("msg-0002"), count("msg-0003")]).toEqual([1, 1, 1]);
    expect(new Set(cids).size).toBe(cids.length); // every echo once, the three configures included
    // Exactly once: the bseq of every event record in the stream strictly increases across the three bridges.
    const bseqs = (await worker.rawEvents()).filter((r) => header(r, "k") === "ev").map((r) => Number(header(r, "b")));
    expect(bseqs.every((b, i) => i === 0 || b > bseqs[i - 1])).toBe(true);
    console.log(
      "s2-live:",
      JSON.stringify({
        claude: claudeToken ? "real" : "fake",
        connects: worker.connects,
        tokensIssued: worker.tokens,
        records: (await worker.rawEvents()).length,
        eventRecords: bseqs.length,
        echoes: cids,
        turns: await turnsDone(),
        staleBridgeAppend: stale,
        replies: (await events()).filter((e) => e.type === "assistant_message").map((e) => String(e.text).slice(0, 40)),
      }),
    );
  });

  // Same session, bridge C still running: a writer that appends without the fence makes the bridge's next append conflict (412
  // seq_num_mismatch), its writer fails, and it reconnects (a new fence, same process) and retries the batch. The turns must come
  // out as if nothing happened: the final message named, an interrupted turn `stopped` with no error.
  it("reconnects when an append fails mid-turn and replays it unchanged (finalMessageId, stopped)", { timeout: 300_000 }, async () => {
    const bridge = children.at(-1)!;
    const interloper = async () => (await admin.withKey((await worker.key()) ?? undefined)).append(worker.streams.events, [{ headers: [["k", "probe"]], body: "" }]);
    const turnCompletes = async () => (await events()).filter((e) => e.type === "turn_complete");
    const after = async (cid: string) => {
      const all = await items();
      const at = all.findIndex((i) => i.kind === "command" && i.cid === cid);
      return at < 0 ? [] : all.slice(at + 1);
    };

    const c0 = worker.connects;
    const done0 = (await turnCompletes()).length;
    await worker.sendCommand("msg-0004", { t: "user_message", id: "msg-0004", text: "Reply with exactly the word: done" });
    await waitFor(async () => (await echoes()).includes("msg-0004"), "msg-0004 acked", 60_000);
    await interloper();
    await waitFor(async () => (await turnCompletes()).length > done0, "the msg-0004 turn", 120_000);
    const doneTurn = (await after("msg-0004")).flatMap((i) => (i.kind === "event" ? JSON.parse(i.body) : []));
    expect(worker.connects).toBe(c0 + 1); // reconnected once, in the same process
    expect(doneTurn.find((e: { type: string }) => e.type === "turn_complete")).toMatchObject({ outcome: "done", finalMessageId: expect.any(String) });

    const c1 = worker.connects;
    await worker.sendCommand("msg-0005", { t: "user_message", id: "msg-0005", text: "Count from 1 to 400, one number per line, nothing else." });
    await waitFor(async () => (await after("msg-0005")).some((i) => i.kind === "event"), "msg-0005 output started", 60_000);
    await interloper();
    await worker.sendCommand("int-0005", { t: "interrupt" });
    await waitFor(async () => (await after("msg-0005")).some((i) => i.kind === "event" && i.body.includes('"turn_complete"')), "the interrupted turn ends", 120_000);
    const stoppedTurn = (await after("msg-0005")).flatMap((i) => (i.kind === "event" ? JSON.parse(i.body) : []));
    if (process.env.S2_LIVE_LOGS)
      console.log(
        "stopped turn:",
        JSON.stringify(stoppedTurn.filter((e: { type: string }) => e.type !== "assistant_delta")),
        JSON.stringify((await after("msg-0005")).map((i) => i.kind + ":" + ("cid" in i ? i.cid : ""))),
      );
    expect(worker.connects).toBe(c1 + 1);
    expect(stoppedTurn.find((e: { type: string }) => e.type === "turn_complete")).toMatchObject({ outcome: "stopped" });
    expect(stoppedTurn.some((e: { type: string; error?: { code?: string } }) => e.type === "error" && e.error?.code === "turn_failed")).toBe(false);

    expect(bridge.exitCode).toBe(null); // the same process throughout
    const cids = await echoes();
    expect(new Set(cids).size).toBe(cids.length);
    const bseqs = (await worker.rawEvents()).filter((r) => header(r, "k") === "ev").map((r) => Number(header(r, "b")));
    expect(bseqs.every((b, i) => i === 0 || b > bseqs[i - 1])).toBe(true);
    console.log(
      "s2-live reconnect:",
      JSON.stringify({
        connects: worker.connects,
        doneTurn: doneTurn.find((e: { type: string }) => e.type === "turn_complete"),
        stoppedTurn: stoppedTurn.find((e: { type: string }) => e.type === "turn_complete"),
        stoppedTurnTypes: [...new Set(stoppedTurn.map((e: { type: string }) => e.type))],
        echoes: cids.slice(-4),
      }),
    );
  });

  // The secure-input tools on a cloud session: the Worker returns the transcript events, the bridge writes them as notes, once each.
  it.skipIf(!claudeToken)("writes a secure input's request and answer to the transcript", { timeout: 300_000 }, async () => {
    const req = { type: "input_request", requestId: "rq-live", title: "Demo key", fields: [{ name: "DEMO_KEY", label: "Demo key" }] };
    let waits = 0;
    worker.rpcResult = (op, args) => {
      if (op !== "input") return null;
      const a = args as { action: string };
      if (a.action === "request") return { requestId: "rq-live", status: "pending", event: req };
      if (a.action === "values") return { values: { DEMO_KEY: "demo-value-123" } };
      waits++;
      return { requestId: "rq-live", status: "provided", names: ["DEMO_KEY"], event: { type: "input_response", requestId: "rq-live", status: "provided", names: ["DEMO_KEY"] } };
    };
    await worker.sendCommand("msg-0006", {
      t: "user_message",
      id: "msg-0006",
      text: "Ask me for a secret named DEMO_KEY with the input_request tool, wait for it with input_wait, then reply with the word: received",
    });
    await waitFor(async () => (await items()).some((i) => i.kind === "command" && i.cid === "msg-0006"), "msg-0006 acked", 60_000);
    await waitFor(async () => (await items()).filter((i) => i.kind === "note").length >= 2 && waits > 0, "both input events", 180_000);
    const notes = (await items()).flatMap((i) => (i.kind === "note" ? JSON.parse(i.body) : [])).filter((e: { requestId?: string }) => e.requestId === "rq-live");
    expect(notes.map((e: { type: string }) => e.type)).toEqual(["input_request", "input_response"]);
    console.log("s2-live inputs:", JSON.stringify({ waits, notes }));
  });
});
