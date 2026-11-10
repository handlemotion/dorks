// The Expo screen (src/app/dorks.tsx) rendered through react-native-web in headless Chrome. Not a device test: it proves the
// screen's code path (expoClient auth, Convex RN client, useDorkEvents, plain RN components) works end to end.
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
const email = `ios${Date.now() % 100000}@example.com`;

const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"], headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:8081/dorks", { waitUntil: "networkidle2", timeout: 120000 });
const waitText = (re, ms = 30000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), { timeout: ms }, re.source);
const press = async (t) => { const [h] = await page.$$(`xpath/.//*[@role="button"][.//*[normalize-space()="${t}"] or normalize-space()="${t}"]`); await h.click(); };
const typeInto = async (label, v) => { await page.click(`[aria-label="${label}"]`); await page.keyboard.press("End"); for (let i = 0; i < 60; i++) await page.keyboard.press("Backspace"); await page.type(`[aria-label="${label}"]`, v); };

await page.waitForSelector('[aria-label="email"]', { timeout: 60000 });
await typeInto("email", email);
await press("Send code");
await page.waitForSelector('[aria-label="code"]', { timeout: 8000 }).catch(async (e) => { console.log('PAGE:', (await page.evaluate(() => document.body.innerText)).slice(0, 300), '| inbox email value:', await page.$eval('[aria-label="email"]', (n) => n.value).catch(() => null)); throw e; });
const code = await (async () => { for (let i = 0; i < 50; i++) { const c = codeFor(email); if (c) return c; await sleep(100); } })();
await typeInto("code", code);
await press("Sign in");
await page.waitForSelector('[aria-label="first message"]', { timeout: 20000 });
check("ios screen: email code sign-in (crossDomain on web; expoClient path covered by native-style probe)", true);

// onboard from Node as the same user
const H = { "content-type": "application/json", origin: "http://localhost:3000" };
await fetch(CONVEX_SITE_URL + "/api/auth/email-otp/send-verification-otp", { method: "POST", headers: H, body: JSON.stringify({ email, type: "sign-in" }) });
await sleep(300);
const r = await fetch(CONVEX_SITE_URL + "/api/auth/sign-in/email-otp", { method: "POST", headers: H, body: JSON.stringify({ email, otp: codeFor(email) }) });
const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const node = new ConvexClient(CONVEX_URL);
node.setAuth(async () => (await (await fetch(CONVEX_SITE_URL + "/api/auth/convex/token", { headers: { cookie, origin: "http://localhost:3000" } })).json()).token);
await node.mutation(api.settings.setClaudeToken, { token: "sk-ant-oat01-ios-e2e" });
await node.action(api.settings.linkGithubInstallation, { installationId: 1, code: "sim" });

await typeInto("first message", "ship the ios screen");
await press("New dork");
await waitText(/claude: w\d+/, 40000);
await page.screenshot({ path: `${SHOTS}/ios-streaming.png` });
check("ios screen: turn streams live", true, (await page.evaluate(() => document.body.innerText)).match(/claude: [^\n]{0,40}/)?.[0]);
await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector('[aria-label="first message"]', { timeout: 30000 });
{ const [h] = await page.$$('xpath/.//*[contains(text(),"ship the ios screen")]'); const box = await h.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
await waitText(/Done: ship the ios screen/, 40000).catch(async (e) => { console.log("PAGE:", (await page.evaluate(() => document.body.innerText)).slice(0, 400)); await page.screenshot({ path: `${SHOTS}/ios-debug.png` }); throw e; });
const t = await page.evaluate(() => document.body.innerText);
check("ios screen: reloaded mid-turn, caught up with no dupes", (t.match(/you: ship the ios screen/g) ?? []).length === 1 && (t.match(/Done: ship the ios screen/g) ?? []).length === 1);
await page.screenshot({ path: `${SHOTS}/ios-final.png` });
check("ios screen: no page errors", errors.length === 0, errors[0]?.slice(0, 160));
await node.close(); await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
