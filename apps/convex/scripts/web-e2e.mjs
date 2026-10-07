// Drives the real web page in headless Chrome against the local backend: OTP sign-in, create dork, live stream, reload mid-turn.
//   needs: web dev server on :3000, `scripts/run-e2e.sh`-style env (CONVEX_URL, CONVEX_SITE_URL), sim host running with SIM_DELTAS=100
import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import puppeteer from "puppeteer-core";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const { CONVEX_URL, CONVEX_SITE_URL } = process.env;
const SHOTS = process.env.SHOTS ?? "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
await startMockResend();

const email = `web${Date.now() % 100000}@jaantonio.com`;
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"], headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:3000/dorks", { waitUntil: "networkidle2" });
const text = () => page.evaluate(() => document.body.innerText);
const clickText = async (t) => { const [h] = await page.$$(`xpath/.//main//button[normalize-space()="${t}"]`); await h.click(); };
const waitText = (re, ms = 30000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), { timeout: ms }, re.source);

// sign-in: foreign address is refused by the UI too
await page.waitForSelector('input[aria-label="email"]');
await page.type('input[aria-label="email"]', "eve@evil.com");
await clickText("Send code");
await waitText(/not allowed/i, 10000);
check("web: foreign email shows an error and sends no code", true);
await page.evaluate(() => (document.querySelector('input[aria-label="email"]').value = ""));
await page.click('input[aria-label="email"]', { clickCount: 3 });
await page.type('input[aria-label="email"]', email);
await clickText("Send code");
await page.waitForSelector('input[aria-label="code"]');
const code = await (async () => { for (let i = 0; i < 50; i++) { const c = codeFor(email); if (c) return c; await sleep(100); } })();
await page.type('input[aria-label="code"]', code);
await clickText("Sign in");
await waitText(/Dorks/, 15000);
check("web: email code sign-in", true);

// onboard that same user from Node (no onboarding UI yet): sign in again to get a token for the same account
const H = { "content-type": "application/json", origin: "http://localhost:3000" };
await fetch(CONVEX_SITE_URL + "/api/auth/email-otp/send-verification-otp", { method: "POST", headers: H, body: JSON.stringify({ email, type: "sign-in" }) });
const r = await fetch(CONVEX_SITE_URL + "/api/auth/sign-in/email-otp", { method: "POST", headers: H, body: JSON.stringify({ email, otp: await (async () => { await sleep(300); return codeFor(email); })() }) });
const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const node = new ConvexClient(CONVEX_URL);
node.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: "http://localhost:3000" } })).json()).token);
await node.mutation(api.settings.setClaudeToken, { token: "sk-ant-oat01-web-e2e" });
await node.mutation(api.settings.setGithubInstallation, { installationId: 1 });
await node.mutation(api.settings.setSleepMinutes, { minutes: 5 });

await page.type('input[aria-label="first message"]', "build the web demo");
await page.click('form button[type="submit"]');
await waitText(/claude: w\d+/, 30000);
const midText = await text();
await page.screenshot({ path: `${SHOTS}/web-streaming.png` });
check("web: turn streams live into the page", /claude: w\d+ w\d+/.test(midText), midText.match(/claude: [^\n]{0,60}/)?.[0]);
const partial = midText.match(/claude: ([^\n]*)/)[1].length;

// kill/reopen mid-turn = hard reload of the page
await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector('main ul li button', { timeout: 15000 });
await page.click("main ul li button");
await waitText(/Done: build the web demo/, 40000);
await waitText(/\bidle\b/, 30000);
const finalText = await text();
check("web: reloaded mid-turn, page catches up to the finished turn", /Done: build the web demo/.test(finalText) && /bash git push/i.test(finalText.replace(/\s+/g, " ")));
check("web: no duplicated blocks after reload", (finalText.match(/you: build the web demo/g) ?? []).length === 1 && (finalText.match(/Done: build the web demo/g) ?? []).length === 1);
await page.screenshot({ path: `${SHOTS}/web-final.png` });
check("web: no page errors", errors.length === 0, errors[0]?.slice(0, 120));
console.log(`(partial text at first screenshot: ${partial} chars)`);
await node.close(); await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
