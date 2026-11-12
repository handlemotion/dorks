// Placeholder UI for the desktop shell. Exercises the shell's commands and events; the real UI is apps/web.
// window.__DORKS__ is injected by the shell before this runs: { apiUrl, bridgePort, publicUrl, ownerToken, tunnel, ... } or { bootError }.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
let cfg = window.__DORKS__ ?? {};

function renderConfig() {
  $("boot-error").hidden = !cfg.bootError;
  $("boot-error").textContent = cfg.bootError ? `Could not start: ${cfg.bootError}` : "";
  $("api").textContent = cfg.apiUrl ?? "n/a";
  $("bridge").textContent = cfg.bridgePort ?? "n/a";
  $("token").textContent = cfg.ownerToken ? `set (${cfg.ownerToken.length} characters, not shown)` : "n/a";
  $("data").textContent = cfg.dataDir ?? "n/a";
  $("version").textContent = cfg.version ?? "n/a";
  $("tunnel").textContent = cfg.tunnel ? `${cfg.tunnel.kind}: ${cfg.tunnel.state}${cfg.tunnel.error ? ` (${cfg.tunnel.error})` : ""}` : "n/a";
  $("public").textContent = cfg.publicUrl ?? "none";
}

function renderStatus(status) {
  const state = status?.state ?? "unknown";
  $("dot").className = `dot ${state}`;
  $("status").textContent = state + (status?.reason ? `: ${status.reason}` : "");
}

async function probe() {
  if (!cfg.apiUrl) return;
  try {
    // no-cors: the point is only whether something answers on the loopback port
    await fetch(`${cfg.apiUrl}/api/health`, { mode: "no-cors", cache: "no-store" });
    $("reach").textContent = "yes (GET /api/health answered)";
  } catch {
    $("reach").textContent = "no";
  }
}

const show = (id, value) => ($(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2));
const guard = (id, fn) => async () => {
  try {
    show(id, await fn());
  } catch (e) {
    show(id, `error: ${e}`);
  }
};

$("restart").onclick = () => invoke("restart_server");
$("open-data").onclick = () => invoke("open_data_dir");
$("save-url").onclick = guard("url-msg", async () => {
  const next = await invoke("set_public_url", { url: $("url").value });
  cfg = window.__DORKS__ ?? cfg;
  renderConfig();
  return next ? "saved; server restarted" : "saved";
});
$("clear-url").onclick = guard("url-msg", async () => {
  await invoke("set_public_url", { url: null });
  cfg = window.__DORKS__ ?? cfg;
  renderConfig();
  return "cleared";
});
$("gh-status").onclick = guard("gh-out", () => invoke("gh_status"));
$("gh-token").onclick = guard("gh-out", async () => {
  const token = await invoke("read_gh_token"); // shows a native consent dialog first
  return token ? `got a token (${token.length} characters, not shown)` : "gh is not installed or not logged in";
});
$("awake-on").onclick = guard("awake-out", async () => `power assertion held: ${await invoke("set_keep_awake", { active: true })}`);
$("awake-off").onclick = guard("awake-out", async () => `power assertion held: ${await invoke("set_keep_awake", { active: false })}`);

renderConfig();
invoke("server_status").then(renderStatus);
listen("dorks://server-status", (e) => {
  renderStatus(e.payload);
  probe();
});
listen("dorks://runtime-config", (e) => {
  cfg = e.payload;
  renderConfig();
});
probe();
setInterval(probe, 5000);
