import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { listening, Services } from "../src/services";
import { tmp } from "./helpers";

// Services (docs/services.md) with real processes: a start waits until the port listens and shows a UI as a preview, a second start
// finds it running, a service that dies is reported with its output, and a stop takes the whole process group down.

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

function services() {
  const work = tmp("work-");
  const shown: number[] = [];
  const started: string[] = [];
  const svc = new Services({
    workDir: work,
    logDir: join(tmp("logs-"), "services"),
    runAs: null,
    env: () => process.env,
    showPreview: async (port) => (shown.push(port), `https://preview.test/${port}`),
    onStart: (name) => void started.push(name),
    log: () => {},
  });
  return { svc, shown, started };
}

describe("services", () => {
  it("start a build's service, wait for its port, show it, find it running again, and stop its whole process group", async () => {
    const port = await freePort();
    const { svc, shown, started } = services();
    // A wrapper shell whose child listens late, like pnpm -> vite: the stop has to reach the child too.
    const server = `node -e "setTimeout(() => require('http').createServer((q, s) => s.end('hello')).listen(${port}), 400)"`;
    svc.set([{ name: "web", command: `echo starting; ${server}`, port, preview: true }]);

    const r = await svc.start({ name: "web", waitSeconds: 20 });
    expect(r).toMatchObject({ name: "web", state: "running", already: false, url: `https://preview.test/${port}` });
    expect(r.readyMs).toBeGreaterThan(300);
    expect(r.tail).toContain("starting");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("hello");
    expect(shown).toEqual([port]);
    expect(started).toEqual(["web"]);

    expect(await svc.start({ name: "web" })).toMatchObject({ state: "running", already: true });
    expect(shown).toEqual([port]);

    expect(await svc.stop("web")).toMatchObject({ state: "stopped" });
    expect(await listening(port)).toBe(false);
  }, 30_000);

  it("report a service that exits before it listens, with its output; refuse a build service's name with another command", async () => {
    const port = await freePort();
    const { svc } = services();
    svc.set([{ name: "api", command: "sleep 30", port }]);
    const r = await svc.start({ name: "broken", command: "echo cannot find module vite; exit 3", port, waitSeconds: 10 });
    expect(r).toMatchObject({ state: "exited", exitCode: 3 });
    expect(r.tail).toContain("cannot find module vite");
    expect(svc.list().map((s) => [s.name, s.source])).toEqual([
      ["api", "build"],
      ["broken", "adhoc"],
    ]);
    await expect(svc.start({ name: "api", command: "true" })).rejects.toThrow(/one of the build's services/);
    await expect(svc.start({ name: "nope" })).rejects.toThrow(/This box has: api, broken/);

    // A port another process holds: readiness would pass on the wrong program, so it is refused.
    const other = createServer().listen(port, "127.0.0.1");
    await new Promise((r) => other.once("listening", r));
    await expect(svc.start({ name: "api" })).rejects.toThrow(/already in use by another process/);
    other.close();
  }, 30_000);
});
