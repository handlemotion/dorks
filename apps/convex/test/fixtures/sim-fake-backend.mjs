// Preloaded into infra/bridge-sim/convex-sim.mjs by test/bridgeSim.test.ts: replaces the ConvexClient network calls with an
// in-memory backend that enforces the same rules as convex/bridge.ts (strict bseq, atomic gap refusal, size/frame caps).
//   FAKE_FAIL=n        first n pushes carrying events throw a transient error
//   FAKE_DROP=1        silently lose one event of the first multi-event push (the backend then sees a gap)
//   FAKE_MAX_BYTES=n   reject (event_too_large) any push holding an event bigger than n bytes
//   FAKE_MAX_FRAMES=n  reject (too_many_frames) any push with more than n frames
//   FAKE_RUN_MS=n      report and exit after n ms
import { ConvexClient } from "convex/browser";

const env = (k, d) => Number(process.env[k] ?? d);
const stored = []; // bseq of every stored event, in order
const control = []; // non-event frames applied
const sizes = [];
let pushes = 0;
let failLeft = env("FAKE_FAIL", 0);
let dropPending = process.env.FAKE_DROP === "1";
let gaps = 0;
let maxSeen = 0; // highest bseq the bridge ever offered, in any attempt: everything up to it must end up stored
const err = (code) => Object.assign(new Error(code), { data: { code, message: code } });

ConvexClient.prototype.mutation = async function (ref, args) {
  const name = String(ref[Symbol.for("functionName")] ?? ref);
  if (name.includes("connect")) return { afterBridgeSeq: 0 };
  if (name.includes("heartbeat")) return;
  let frames = args.frames;
  pushes++;
  for (const f of frames) if (f.t === "event") maxSeen = Math.max(maxSeen, f.bseq);
  if (frames.some((f) => f.t === "event") && failLeft-- > 0) throw new Error("transient network error"); // pushes carrying events only
  if (frames.length > env("FAKE_MAX_FRAMES", 500)) throw err("too_many_frames");
  for (const f of frames) if (f.t === "event" && JSON.stringify(f.raw).length > env("FAKE_MAX_BYTES", 256 * 1024)) throw err("event_too_large");
  const evs = frames.filter((f) => f.t === "event");
  if (dropPending && evs.length > 3) {
    dropPending = false;
    frames = frames.filter((f) => f !== evs[1]);
  }
  let next = stored.length + 1;
  for (const f of frames) {
    if (f.t !== "event" || f.bseq < next) continue;
    if (f.bseq !== next) {
      gaps++;
      return { ok: false, expectedBseq: stored.length + 1 };
    }
    next++;
  }
  for (const f of frames) {
    if (f.t !== "event") control.push(f.id ? `${f.t}:${f.id}` : f.t);
    else if (f.bseq === stored.length + 1) {
      stored.push(f.bseq);
      sizes.push(JSON.stringify(f.raw).length);
    }
  }
  return { ok: true };
};
ConvexClient.prototype.action = async () => ({ repo: { fullName: "o/r", branch: "b" }, env: {}, ghToken: "x", resumeSessionId: null });
ConvexClient.prototype.onUpdate = function (_ref, _args, cb) {
  setTimeout(() => cb([{ cid: "cfg", frame: { t: "fetch_configure" } }]), 10);
  setTimeout(() => cb([{ cid: "m1", frame: { t: "user_message", id: "m1", text: "hi" } }]), 200);
  setTimeout(() => cb([{ cid: "fl1", frame: { t: "flush" } }]), env("FAKE_RUN_MS", 2500) - 800);
  return () => {};
};
setTimeout(() => {
  console.log("RESULT " + JSON.stringify({ stored, control, gaps, pushes, maxSeen, maxSize: Math.max(...sizes) }));
  process.exit(0);
}, env("FAKE_RUN_MS", 2500));
