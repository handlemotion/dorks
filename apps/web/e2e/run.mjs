// Drives the BUILT web app (apps/web/dist/client) in headless Chrome: connect with the owner token, first-run setup, create a
// session, stream a turn, follow up, reload, archive, and the settings page.
//
// By default it starts the in-memory mock server (packages/client/src/mock-server.ts) so it needs nothing else. To drive a real
// `dorks-server` instead, set E2E_SERVER_URL and E2E_TOKEN; the server must allow the origin http://localhost:3000 in
// DORKS_UI_ORIGINS (BOX_PROVIDER=sim works). A fresh server is walked through setup; an already configured one skips it. Without
// a running agent (the sim host) a real server never answers, so the agent-turn checks only run with E2E_AGENT=1.
//
//   pnpm --filter @dorks/web build && pnpm --filter @dorks/web e2e
//   env: CHROME_PATH (Chrome/Chromium binary), SHOTS (screenshot dir, default /tmp), E2E_WEB_PORT (default 3000)
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "../dist/client");
const SHOTS = process.env.SHOTS ?? "/tmp";
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const ORIGIN = `http://localhost:${WEB_PORT}`;
const real = !!process.env.E2E_SERVER_URL;
const agent = !real || process.env.E2E_AGENT === "1";

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`no build at ${DIST}: run \`pnpm --filter @dorks/web build\` first`);
  process.exit(2);
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  join(homedir(), "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
].filter(Boolean);
const executablePath = chromeCandidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error("no Chrome found: set CHROME_PATH");
  process.exit(2);
}

// ---- servers -----------------------------------------------------------------------------------------------------------
let mock;
let serverUrl = process.env.E2E_SERVER_URL;
let token = process.env.E2E_TOKEN;
if (!real) {
  const { startMockServer } = await import("../../../packages/client/src/mock-server.ts");
  mock = await startMockServer({ tick: 100, token: "e2e-owner-token" });
  serverUrl = mock.url;
  token = mock.token;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json" };
const web = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, ORIGIN).pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path === "/" ? "index.html" : path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => web.listen(WEB_PORT, "127.0.0.1", r));

// ---- helpers -----------------------------------------------------------------------------------------------------------
const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
};
const browser = await puppeteer.launch({ executablePath, args: ["--no-sandbox", "--disable-gpu"], headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

const text = () => page.evaluate(() => document.body.innerText);
const waitText = (re, ms = 15000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), { timeout: ms }, re.source);
const button = async (label) => {
  const [h] = await page.$$(`xpath/.//button[normalize-space()="${label}"] | .//a[normalize-space()="${label}"]`);
  if (!h) throw new Error(`no button "${label}"`);
  return h;
};
const click = async (label) => (await button(label)).click();
/** A button inside the settings section with this heading (several sections share the label "Save"). */
const clickIn = async (heading, label) => {
  const [h] = await page.$$(`xpath/.//section[.//h2[normalize-space()="${heading}"]]//button[normalize-space()="${label}"]`);
  if (!h) throw new Error(`no "${label}" in "${heading}"`);
  await h.click();
};
const fill = async (aria, value) => {
  const sel = `[aria-label="${aria}"]`;
  await page.waitForSelector(sel);
  await page.$eval(sel, (el) => el.select?.());
  await page.type(sel, value);
};
const shot = (name) => page.screenshot({ path: join(SHOTS, `web-${name}.png`) });
const transcript = () => page.$eval('[data-testid="transcript"]', (el) => el.textContent).catch(() => "");

try {
  // ---- connect -------------------------------------------------------------------------------------------------------------
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle2" });
  await waitText(/Connect to your dorks server/);
  check("fresh browser asks for the server and owner token", true);
  await shot("connect");

  await fill("server", serverUrl);
  await fill("owner token", "wrong-token");
  await click("Connect");
  await waitText(/rejected that owner token/);
  check("a wrong owner token is refused with a clear message", true);

  await fill("owner token", token);
  await click("Connect");

  // ---- first-run setup (a fresh server is unconfigured) --------------------------------------------------------------------
  const landed = await (await page.waitForFunction(() => (document.querySelector('[data-testid="onboarding"]') ? "onboarding" : document.querySelector('[data-onboarding="complete"]') ? "app" : false), { timeout: 15000 })).jsonValue();
  if (landed === "onboarding") {
    const waitStep = (name) => page.waitForFunction((n) => document.querySelector('[data-testid="onboarding"]')?.getAttribute("data-step") === n, { timeout: 15000 }, name);
    const clickEnabled = async (label) => {
      await page.waitForFunction((l) => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === l && !b.disabled), { timeout: 15000 }, label);
      await click(label);
    };
    check("an unconfigured server sends the owner to onboarding", page.url().includes("#/onboarding"), page.url());
    await waitStep("welcome");
    check("onboarding is a bare page: no sidebar or app chrome", !(await page.$(".app-shell, .app-main")));
    check("the first page is the welcome", /Welcome to Dorks/.test(await text()));
    await shot("onboarding-1-welcome");
    await clickEnabled("Get started");

    await waitStep("boat");
    check("Continue waits for a Boat key", await page.$eval('form button[type="submit"]', (b) => b.disabled));
    await shot("onboarding-2-boat");
    await fill("boat api key", "boat_e2e_key");
    await clickEnabled("Continue");

    await waitStep("prepare");
    // Resumable: the server's settings, not the browser, decide where onboarding starts.
    await page.reload({ waitUntil: "networkidle2" });
    await waitStep("prepare");
    check("reopening onboarding resumes at the first missing step", true);
    await shot("onboarding-3-prepare");
    await click("Prepare Boat");
    await waitText(/Step \d of 7/, 10000);
    check("Prepare Boat shows the build's progress", true);
    await shot("onboarding-3-prepare-building");
    await waitText(/Ready\. Sessions start from/, 30000);
    check("Prepare Boat finishes and the new snapshot is in use", true);
    await shot("onboarding-3-prepare-ready");
    await clickEnabled("Continue");

    await waitStep("agent");
    await shot("onboarding-4-agent");
    await fill("Boat environment", "dorks-codex");
    await clickEnabled("Continue");

    await waitStep("github");
    await shot("onboarding-5-github");
    check("the GitHub step lists the permissions the token needs", /Contents/.test(await page.$eval("details", (d) => ((d.open = true), d.textContent))));
    await fill("github token", "github_pat_e2e");
    await clickEnabled("Continue");

    await waitStep("tunnel");
    await shot("onboarding-6-tunnel");
    // A configured server shows the address and Continue; an unconfigured one explains what breaks and offers Skip.
    if (await page.$('[data-testid="tunnel-status"]')) {
      check("a configured public URL is shown and needs no skip", !/Skip for now/.test(await text()));
      await clickEnabled("Continue");
    } else {
      check("the public URL step says what breaks without it", /sessions cannot start/i.test(await text()));
      await click("Skip for now");
    }

    await waitStep("done");
    await shot("onboarding-7-done");
    check("onboarding walks welcome, Boat key, snapshot, agent, GitHub, public URL and done", true);
    await clickEnabled("Start your first session");
  }

  // ---- first session -------------------------------------------------------------------------------------------------------
  await page.waitForSelector('[data-onboarding="complete"]', { timeout: 15000 });
  check("dorks page opens once onboarding is complete", true);
  await fill("repo", "acme/demo");
  await page.type('textarea[aria-label="first message"]', "build the demo");
  await page.click('form button[type="submit"]');
  await page.waitForSelector('[data-testid="transcript"]', { timeout: 15000 });
  if (agent) {
    await waitText(/Done: build the demo/, 30000);
    await page.waitForFunction(() => /\bidle\b/.test(document.querySelector('[data-testid="state"]')?.textContent ?? ""), { timeout: 30000 });
    const first = await transcript();
    check("a turn streams into the transcript and the session goes idle", /build the demo/.test(first) && /Done: build the demo/.test(first));
  } else {
    await waitText(/build the demo/, 15000);
    check("the new session shows the first message", true);
  }
  await shot("thread");

  // ---- follow-up, reload ---------------------------------------------------------------------------------------------------
  await page.type('textarea[aria-label="message"]', "now add tests");
  await page.click('form button[type="submit"]');
  await waitText(/now add tests/, 5000);
  if (agent) await waitText(/Done: now add tests/, 30000);
  const second = await transcript();
  check("a follow-up is shown once" + (agent ? " and answered once" : ""), (second.match(/now add tests/g) ?? []).length >= 1 && (!agent || (second.match(/Done: now add tests/g) ?? []).length === 1));

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="transcript"]', { timeout: 15000 });
  await waitText(agent ? /Done: now add tests/ : /now add tests/, 15000);
  const reloaded = await transcript();
  check("after a reload the connection and the transcript come back without duplicates", (reloaded.match(/build the demo/g) ?? []).length === (agent ? 2 : 1) && (reloaded.match(/now add tests/g) ?? []).length === (agent ? 2 : 1));

  // ---- archive ---------------------------------------------------------------------------------------------------------------
  await click("Archive");
  await page.waitForFunction(() => /archived/.test(document.querySelector('[data-testid="state"]')?.textContent ?? ""), { timeout: 10000 });
  check("archiving a session marks it archived", true);

  // ---- settings ------------------------------------------------------------------------------------------------------------
  await page.goto(`${ORIGIN}/#/settings`, { waitUntil: "networkidle2" });
  await waitText(/Sleep after idle/);
  await page.$eval('[aria-label="sleep minutes"]', (el) => (el.value = ""));
  await fill("sleep minutes", "7");
  await clickIn("Sleep after idle", "Save");
  await page.waitForFunction(() => document.querySelector('[data-testid="sleep-current"]')?.textContent === "7", { timeout: 10000 });
  check("sleep minutes saves and shows the stored value", true);

  await fill("secret name", "E2E_SECRET");
  await fill("secret value", "hunter2");
  await clickIn("CLI secrets", "Save secret");
  await waitText(/E2E_SECRET/);
  const secretsText = await text();
  check("a CLI secret is listed by name and its value is never shown", /E2E_SECRET/.test(secretsText) && !/hunter2/.test(secretsText));
  await (await page.$('[aria-label="delete E2E_SECRET"]')).click();
  await page.waitForFunction(() => !document.body.innerText.includes("E2E_SECRET"), { timeout: 10000 });
  check("a CLI secret can be removed", true);

  await page.select('[aria-label="comment policy mode"]', "allowlist");
  await fill("allowed logins", "alice, coderabbitai[bot]");
  await clickIn("PR comments", "Save");
  await page.waitForFunction(() => [...document.querySelectorAll("section")].some((s) => s.querySelector("h2")?.textContent === "PR comments" && /Saved\./.test(s.innerText)), { timeout: 10000 });
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector('[aria-label="comment policy mode"]');
  check("comment policy persists across a reload", (await page.$eval('[aria-label="comment policy mode"]', (el) => el.value)) === "allowlist");
  await shot("settings");

  // ---- Prepare Boat on the settings page: stale warning, failure with retry (the mock scripts both) -------------------------
  if (mock) {
    mock.snapshot.newBridge();
    await page.waitForSelector('[data-testid="snapshot-stale"]', { timeout: 10000 });
    check("a snapshot built with an older bridge is flagged for update", /older bridge/.test(await text()));
    await shot("settings-snapshot-stale");
    mock.snapshot.failNextBuild("The installer failed (exit 100). E: Unable to locate package");
    await clickIn("Base snapshot", "Update snapshot");
    await page.waitForSelector('[data-testid="snapshot-error"]', { timeout: 10000 });
    const failed = await text();
    check("a failed build shows why and that sessions keep the old snapshot", /The build failed: The installer failed \(exit 100\)/.test(failed) && /Sessions keep using/.test(failed));
    await shot("settings-snapshot-failed");
    await clickIn("Base snapshot", "Retry");
    await page.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 15000 });
    check("retrying rebuilds and the stale warning is gone", !(await page.$('[data-testid="snapshot-stale"]')));
  }

  check("the page logged no errors", errors.length === 0, errors[0]?.slice(0, 160));
} catch (e) {
  check(`unexpected failure: ${String(e).slice(0, 200)}`, false);
  await shot("failure").catch(() => {});
  console.log("page text at failure:\n" + (await text().catch(() => "")).slice(0, 600));
} finally {
  await browser.close();
  web.close();
  await mock?.close();
}
process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1);
