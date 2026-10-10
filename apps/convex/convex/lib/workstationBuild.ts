// Builds the base snapshot ("workstation image") inside a user's OWN Upstash account, from their own API key: the same steps as
// infra/snapshot/print-build-plan.sh (Claude Code CLI, the dorks-bridge bundle, a pinned gh and gh-stack), run through the Box REST API.
// The user pays Upstash for the build box (a few minutes of CPU) and for the snapshot's storage; dorks pays nothing.
//
// Error policy as in upstash.ts: messages carry the step and HTTP status, never response bodies (they can echo what was sent). The one
// exception is a failed install step's own console output, which is logged server-side (no secrets are ever put in these commands).

const DEFAULT_BASE_URL = "https://us-east-1.box.upstash.com";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type BuildOptions = {
  apiKey: string;
  baseUrl?: string;
  /** The dorks-bridge bundle (infra/bridge/dist/cli.mjs). */
  bundle: Blob;
  /** Names the snapshot, e.g. "dorks-base-20261010". */
  snapshotName: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
};

export class WorkstationBuildError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "WorkstationBuildError";
  }
}

// Pinned and checksum-verified, same as infra/snapshot/print-build-plan.sh (bump both together).
const GH_VERSION = "2.102.0";
const STACK_VERSION = "0.2.0";

export const INSTALL_TOOLS = `sudo npm install -g @anthropic-ai/claude-code && sudo install -m 0755 /workspace/home/dorks-bridge.mjs /usr/local/bin/dorks-bridge && rm /workspace/home/dorks-bridge.mjs && sudo ln -sf dorks-bridge /usr/local/bin/dorks && sudo ln -sf dorks-bridge /usr/local/bin/gh`;

export const INSTALL_GH = `set -e
case "$(uname -m)" in
  x86_64)  ARCH=amd64; GH_SHA=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386; STACK_SHA=577065033b49d4505730ea0ad43ab1b0374b0d9b1308e9765647a6aa8eba3cb7 ;;
  aarch64) ARCH=arm64; GH_SHA=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484; STACK_SHA=d29684746f337a580667605b34877e5624792bcc390e61473a050bd4839557bf ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
T="$(mktemp -d)"; cd "$T"
curl -fsSL -o gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$ARCH.tar.gz"
echo "$GH_SHA  gh.tgz" | sha256sum -c -
tar -xzf gh.tgz --strip-components=1
sudo install -m 0755 bin/gh /usr/bin/gh
curl -fsSL -o gh-stack "https://github.com/github/gh-stack/releases/download/v${STACK_VERSION}/linux-$ARCH"
echo "$STACK_SHA  gh-stack" | sha256sum -c -
EXT="$HOME/.local/share/gh/extensions/gh-stack"; mkdir -p "$EXT"
install -m 0755 gh-stack "$EXT/gh-stack"
printf "owner: github\\nname: gh-stack\\nhost: github.com\\ntag: v${STACK_VERSION}\\nispinned: true\\n" > "$EXT/manifest.yml"
rm -rf "$T"`;

export const VERIFY = `node --version && git --version && claude --version && command -v dorks-bridge && command -v dorks && test "$(command -v gh)" = /usr/local/bin/gh && /usr/bin/gh --version && gh --version && gh stack --help >/dev/null && dorks --help >/dev/null`;

/** Cheap authenticated call: lists the account's boxes. Throws on a bad key; returns nothing else. */
export async function verifyUpstashKey(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): Promise<void> {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${base}/v2/box?label=dorks-key-check`, { headers: { "X-Box-Api-Key": opts.apiKey }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new WorkstationBuildError("could not reach Upstash");
  }
  await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) throw new WorkstationBuildError("Upstash rejected this API key", res.status);
  if (!res.ok) throw new WorkstationBuildError(`Upstash answered HTTP ${res.status}`, res.status);
}

/** Runs the whole build and returns the new snapshot's id. Always deletes the build box, also on failure. */
export async function buildBaseSnapshot(o: BuildOptions): Promise<string> {
  const base = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});

  async function api(step: string, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<any> {
    const headers: Record<string, string> = { "X-Box-Api-Key": o.apiKey };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new WorkstationBuildError(`${step}: network error (${e instanceof Error ? e.name : "unknown"})`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new WorkstationBuildError(`${step}: HTTP ${res.status}`, res.status);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new WorkstationBuildError(`${step}: invalid JSON response`);
    }
  }

  async function exec(boxId: string, step: string, command: string) {
    const r = await api(step, "POST", `/v2/box/${boxId}/exec`, { command: ["sh", "-c", command] }, 290_000);
    if (r.exit_code !== 0) {
      log(`${step} failed (exit ${r.exit_code}): ${String(r.output ?? "").slice(-600)} ${String(r.error ?? "").slice(-300)}`);
      throw new WorkstationBuildError(`${step}: command failed (exit ${r.exit_code})`);
    }
  }

  async function waitFor(step: string, maxMs: number, poll: () => Promise<boolean>) {
    const deadline = now() + maxMs;
    while (!(await poll())) {
      if (now() >= deadline) throw new WorkstationBuildError(`${step}: timed out`);
      await sleep(2_000);
    }
  }

  // Box names are unique per account, so a leftover build box must not block the next build: the name carries a random suffix.
  const created = await api("create build box", "POST", "/v2/box", { name: `dorks-base-build-${crypto.randomUUID().slice(0, 8)}`, runtime: "node", labels: ["dorks-base"] });
  const boxId: string = created.id;
  if (typeof boxId !== "string" || !SAFE_ID.test(boxId)) throw new WorkstationBuildError("create build box: response had no usable id");
  try {
    log(`build box ${boxId}`);
    await waitFor("build box start", 240_000, async () => {
      const b = await api("build box status", "GET", `/v2/box/${boxId}`);
      if (b.status === "error" || b.status === "deleted") throw new WorkstationBuildError(`build box start: status ${b.status}`);
      return b.status !== "creating";
    });

    const form = new FormData();
    form.append("paths", "/workspace/home/dorks-bridge.mjs");
    form.append("files", o.bundle, "dorks-bridge.mjs");
    await api("upload bridge", "POST", `/v2/box/${boxId}/files/upload`, form, 120_000);
    await exec(boxId, "install claude and bridge", INSTALL_TOOLS);
    await exec(boxId, "install gh", INSTALL_GH);
    await exec(boxId, "verify image", VERIFY);

    const snap = await api("create snapshot", "POST", `/v2/box/${boxId}/snapshots`, { name: o.snapshotName });
    const snapshotId: string = snap.id;
    if (typeof snapshotId !== "string" || !SAFE_ID.test(snapshotId)) throw new WorkstationBuildError("create snapshot: response had no usable id");
    await waitFor("snapshot", 240_000, async () => {
      const list = await api("snapshot status", "GET", `/v2/box/${boxId}/snapshots`);
      const s = (list.snapshots ?? []).find((x: any) => x.id === snapshotId);
      if (s?.status === "error" || s?.status === "failed") throw new WorkstationBuildError("snapshot: build failed");
      return s?.status === "ready";
    });
    log(`snapshot ${snapshotId} ready`);
    return snapshotId;
  } finally {
    await api("delete build box", "DELETE", `/v2/box/${boxId}`).catch((e) => log(`could not delete build box ${boxId}: ${e instanceof Error ? e.message : "unknown"}`));
  }
}

/** Best effort: removes a superseded snapshot (explicit id only, never `?all=true`). */
export async function deleteSnapshot(o: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; snapshotId: string }): Promise<void> {
  if (!SAFE_ID.test(o.snapshotId)) return;
  const base = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  await (o.fetch ?? fetch)(`${base}/v2/box/snapshots`, {
    method: "DELETE",
    headers: { "X-Box-Api-Key": o.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [o.snapshotId] }),
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.text()).catch(() => {});
}
