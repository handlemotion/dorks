// The OpenCode engine through the real web page (headless Chrome) and the real in-box bridge: onboard WITHOUT a Claude token, pick
// OpenCode as the default engine on the settings page, create a dork from the dorks page, and watch its turn stream in.
//   needs: web dev server on :3000, the local backend (CONVEX_URL, CONVEX_SITE_URL), the dev mail catcher stopped (this starts its own on
//   :8899), and the sim host with the real bridge: `BRIDGE_IMPL=real node infra/bridge-sim/host.mjs`. With OPENCODE_BIN unset the sim's
//   boxes run the fake server (infra/bridge/test/fixtures/fake-opencode.mjs). For the real `opencode serve`, also run a model it can call,
//   e.g. infra/bridge/test/fixtures/mock-llm.mjs, and pass its OpenCode provider config file here as OPENCODE_PROVIDER_CONFIG (it is saved
//   as the user's OPENCODE_CONFIG CLI secret, the way a user would add a custom provider).
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import puppeteer from "puppeteer-core";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL, OPENCODE_PROVIDER_CONFIG } = process.env;
const MODEL = process.env.OPENCODE_MODEL ?? (OPENCODE_PROVIDER_CONFIG ? "mock/mock-model" : "anthropic/claude-sonnet-4-5");
const SHOTS = process.env.SHOTS ?? "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
await startMockResend();

const email = `oc${Date.now() % 100000}@dorks.build`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"], headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const text = () => page.evaluate(() => document.body.innerText);
const clickText = async (t) => { const [h] = await page.$$(`xpath/.//main//button[normalize-space()="${t}"]`); await h.click(); };
const waitText = (re, ms = 30000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), { timeout: ms }, re.source);
const code = async () => { for (let i = 0; i < 50; i++) { const c = codeFor(email); if (c) return c; await sleep(100); } };

await page.goto("http://localhost:3000/dorks", { waitUntil: "networkidle2" });
await page.waitForSelector('input[aria-label="email"]');
await page.type('input[aria-label="email"]', email);
await clickText("Send code");
await page.waitForSelector('input[aria-label="code"]');
await page.type('input[aria-label="code"]', await code());
await clickText("Sign in");
await waitText(/Dorks/, 15000);

// Onboard the same account from Node: GitHub (sim) and a provider credential, but no Claude token.
const H = { "content-type": "application/json", origin: "http://localhost:3000" };
await fetch(CONVEX_SITE_URL + "/api/auth/email-otp/send-verification-otp", { method: "POST", headers: H, body: JSON.stringify({ email, type: "sign-in" }) });
await sleep(300);
const r = await fetch(CONVEX_SITE_URL + "/api/auth/sign-in/email-otp", { method: "POST", headers: H, body: JSON.stringify({ email, otp: await code() }) });
const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const node = new ConvexClient(CONVEX_URL);
node.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: "http://localhost:3000" } })).json()).token);
await node.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });
await node.mutation(api.settings.setCliSecret, { name: "ANTHROPIC_API_KEY", value: "sk-ant-api03-opencode-web-e2e" });
if (OPENCODE_PROVIDER_CONFIG) await node.mutation(api.settings.setCliSecret, { name: "OPENCODE_CONFIG", value: OPENCODE_PROVIDER_CONFIG });

// Settings page: Claude Code is still the default, so onboarding is incomplete without a Claude token; switching to OpenCode completes it.
await page.goto("http://localhost:3000/settings", { waitUntil: "networkidle2" });
await page.waitForSelector('select[aria-label="default engine"]');
check("settings: Claude Code is the default engine", (await page.$eval('select[aria-label="default engine"]', (s) => s.value)) === "claude");
check("settings: without a Claude token, onboarding is not done for Claude Code", /Finish the steps above/.test(await text()));
check("settings: the provider key is detected", /A provider key is saved/.test(await page.$eval('[data-testid="provider-key-status"]', (e) => e.textContent)));
await page.select('select[aria-label="default engine"]', "opencode");
await waitText(/Ready: you can create dorks/, 10000);
check("settings: OpenCode as default completes onboarding with no Claude token", true);
await page.type('input[aria-label="opencode model"]', MODEL);
await clickText("Save model");
await page.waitForFunction((m) => document.querySelector('[data-testid="opencode-model"]')?.textContent === m, { timeout: 10000 }, MODEL);
check("settings: the OpenCode model is saved", true);
await page.screenshot({ path: `${SHOTS}/opencode-settings.png` });

// Dorks page: the engine picker follows the default; create the dork from the form.
await page.goto("http://localhost:3000/dorks", { waitUntil: "networkidle2" });
await page.waitForSelector('[data-onboarding="complete"]', { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('select[aria-label="engine"]')?.value === "opencode", { timeout: 10000 });
check("dorks: the engine picker defaults to OpenCode", true);
await page.type('input[aria-label="first message"]', "show me the readme");
await page.click('form button[type="submit"]');
await waitText(/opencode: /, 60000);
await waitText(/\bidle\b/, 60000);
await sleep(500);
const done = (await text()).replace(/[ \t]+/g, " ");
await page.screenshot({ path: `${SHOTS}/opencode-thread.png`, fullPage: true });
check("thread: shows the engine", /OpenCode/.test(await page.$eval('[data-testid="engine"]', (e) => e.textContent)));
check("thread: the agent's text streamed in under the engine's name", /opencode: \S/.test(done), done.match(/opencode: [^\n]{0,60}/)?.[0]);
check("thread: a tool call and its result", /bash .*— ok/.test(done), done.match(/bash [^\n]{0,80}/)?.[0]);
check("list: the dork shows its engine", /· OpenCode ·/.test(done));
const dork = (await node.query(api.dorks.list, {}))[0];
check("backend: the dork is an OpenCode dork with a stored session", dork?.engine === "opencode" && /^ses_/.test(dork?.claudeSessionId ?? ""), `${dork?.engine} ${dork?.claudeSessionId}`);

// A second turn on the same session.
await page.type('section[aria-label="thread"] input[aria-label="message"]', "and again");
await clickText("Send");
await page.waitForFunction(() => (document.body.innerText.match(/opencode: /g) ?? []).length >= 4, { timeout: 60000 });
check("thread: a second turn on the same session", true);
check("web: no page errors", errors.length === 0, errors[0]?.slice(0, 120));
await node.close(); await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
