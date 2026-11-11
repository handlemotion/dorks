import { connect } from "node:net";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcError, RpcServer, rpcCall, type RpcMethods } from "../src/rpc";
import { sleep, tmp } from "./helpers";

let servers: RpcServer[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(methods: RpcMethods, maxLine?: number) {
  const dir = tmp("rpc-");
  const server = new RpcServer(join(dir, "sub/rpc.sock"), methods, null, maxLine);
  servers.push(server);
  await server.start();
  return server;
}

/** Raw wire access: writes bytes, collects reply lines until the server closes. */
function raw(sock: string, payload: string, end = true) {
  return new Promise<string[]>((resolve) => {
    let out = "";
    const s = connect(sock, () => (end ? s.end(payload) : s.write(payload)));
    s.setEncoding("utf8");
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out.split("\n").filter(Boolean)));
    s.on("error", () => resolve(out.split("\n").filter(Boolean)));
  });
}

describe("rpc", () => {
  it("serves methods, passes params, defaults them to {}, and maps undefined results to null", async () => {
    const s = await serve({ echo: (p) => ({ got: p }), nothing: () => undefined, slow: async () => (await sleep(10), "late") });
    expect(await rpcCall(s.sockPath, "echo", { a: 1 })).toEqual({ got: { a: 1 } });
    expect(await rpcCall(s.sockPath, "echo")).toEqual({ got: {} });
    expect(await rpcCall(s.sockPath, "nothing")).toBeNull();
    expect(await rpcCall(s.sockPath, "slow")).toBe("late");
  });

  it("the socket is 0600 inside a 0700 dir", async () => {
    const s = await serve({});
    expect(statSync(s.sockPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.sockPath, "..")).mode & 0o777).toBe(0o700);
  });

  it("answers several requests on one connection, in order", async () => {
    const s = await serve({ n: async (p) => (await sleep((p as { ms: number }).ms), (p as { n: number }).n) });
    const replies = await raw(s.sockPath, ['{"method":"n","params":{"n":1,"ms":40}}', '{"method":"n","params":{"n":2,"ms":0}}', ""].join("\n"));
    expect(replies.map((r) => JSON.parse(r).result)).toEqual([1, 2]);
  });

  it("reassembles a request split across writes", async () => {
    const s = await serve({ echo: (p) => p });
    const replies = await new Promise<string[]>((resolve) => {
      let out = "";
      const c = connect(s.sockPath, async () => {
        c.write('{"method":"ec');
        await sleep(20);
        c.end('ho","params":{"x":1}}\n');
      });
      c.setEncoding("utf8");
      c.on("data", (d) => (out += d));
      c.on("close", () => resolve(out.split("\n").filter(Boolean)));
    });
    expect(JSON.parse(replies[0]!)).toEqual({ ok: true, result: { x: 1 } });
  });

  it("rejects what it cannot serve with a coded error and keeps the connection usable", async () => {
    const s = await serve({ ok: () => 1 });
    const [bad, noMethod, inherited, good] = (await raw(s.sockPath, ["not json", '{"params":{}}', '{"method":"constructor"}', '{"method":"ok"}', ""].join("\n"))).map((l) => JSON.parse(l));
    expect(bad).toEqual({ ok: false, error: { code: "invalid", message: expect.any(String) } });
    expect(noMethod.error.code).toBe("unknown_method");
    expect(inherited.error.code).toBe("unknown_method"); // not resolved through Object.prototype
    expect(good).toEqual({ ok: true, result: 1 });
  });

  it("passes RpcError codes through, but hides the message of any other failure", async () => {
    const s = await serve({
      denied: () => {
        throw new RpcError("denied", "nope");
      },
      boom: () => {
        throw new Error("secret-token-ghs_abc leaked in a message");
      },
    });
    await expect(rpcCall(s.sockPath, "denied")).rejects.toMatchObject({ code: "denied", message: "nope" });
    const err = (await rpcCall(s.sockPath, "boom").catch((e) => e)) as RpcError;
    expect(err).toMatchObject({ code: "failed", message: "internal error" });
    expect(String(err.message)).not.toContain("ghs_");
  });

  it("drops a connection that sends an endless line", async () => {
    const s = await serve({ ok: () => 1 }, 64 * 1024);
    const replies = await raw(s.sockPath, "x".repeat(64 * 1024 + 10), false);
    expect(replies).toEqual([]);
    expect(await rpcCall(s.sockPath, "ok")).toBe(1); // the server itself is fine
  });

  it("rpcCall: unreachable when nothing listens, and when the bridge does not answer in time", async () => {
    await expect(rpcCall(join(tmp("none-"), "x.sock"), "ok")).rejects.toMatchObject({ code: "unreachable" });
    const s = await serve({ hang: () => new Promise(() => {}) });
    await expect(rpcCall(s.sockPath, "hang", {}, 80)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("close() removes the socket, and a restart replaces a stale one", async () => {
    const s = await serve({ ok: () => 1 });
    s.close();
    await expect(rpcCall(s.sockPath, "ok")).rejects.toMatchObject({ code: "unreachable" });
    await s.start();
    expect(await rpcCall(s.sockPath, "ok")).toBe(1);
  });
});
