// Onboards entirely through the web UI (no Node client): email-code sign-in, the "setup incomplete" prompt, Claude token,
// CLI secret (names only), sleep minutes, GitHub linking via the sim callback (BOX_PROVIDER=sim, code=sim), then create a dork
// and watch it stream. Also covers the /dorks fixes: no double create, no draft leaking between dorks.
//   needs: web dev server on :3000 started with VITE_GITHUB_APP_SLUG=dorks-test, env CONVEX_URL-style vars like web-e2e.mjs,
//          sim host running with SIM_DELTAS=100, Convex BOX_PROVIDER=sim
import puppeteer from "puppeteer-core";
import { codeFor, startMockResend } from "./mock-resend.mjs";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
const SLUG = process.env.VITE_GITHUB_APP_SLUG ?? "dorks-test";
const CLAUDE_TOKEN = "sk-ant-oat01-settings-e2e-token";
const SECRET_VALUE = "settings-e2e-secret-value";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
await startMockResend();

const email = `settings${Date.now() % 100000}@jaantonio.com`;
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-gpu"], headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const text = () => page.evaluate(() => document.body.innerText);
const waitText = (re, ms = 30000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), { timeout: ms }, re.source);
const clickText = async (t) => { const [h] = await page.$$(`xpath/.//main//button[normalize-space()="${t}"]`); await h.click(); };
const typeInto = async (label, value) => { const sel = `input[aria-label="${label}"]`; await page.waitForSelector(sel); await page.focus(sel); await page.$eval(sel, (i) => i.select()); await page.type(sel, value); };

// ---- sign in (email code, through the UI)
await page.goto(`${WEB}/dorks`, { waitUntil: "networkidle2" });
await typeInto("email", email);
await clickText("Send code");
await page.waitForSelector('input[aria-label="code"]');
const code = await (async () => { for (let i = 0; i < 50; i++) { const c = codeFor(email); if (c) return c; await sleep(100); } })();
await typeInto("code", code);
await clickText("Sign in");
await waitText(/Dorks/, 15000);

// ---- fresh account: /dorks nudges to settings and refuses to create
await waitText(/Setup is incomplete/, 10000);
check("dorks: shows a settings link while onboarding is incomplete", true);
await typeInto("repo", "jaantonio/demo");
await typeInto("first message", "too early");
await clickText("New dork");
await waitText(/finish onboarding/i, 10000);
check("dorks: create before onboarding shows the backend error", true);

// ---- settings: checklist starts empty
await page.click('a[href="/settings"]');
await page.waitForSelector('[data-testid="check-claude"]');
const check0 = await page.$eval('[data-testid="check-claude"]', (e) => e.textContent) + await page.$eval('[data-testid="check-github"]', (e) => e.textContent);
check("settings: checklist starts with both steps open", !check0.includes("✅"), check0);
const href = await page.$eval('main a[href*="github.com/apps"]', (a) => a.getAttribute("href"));
check("settings: install link points at the App's installation page", href === `https://github.com/apps/${SLUG}/installations/new`, href);

// ---- Claude token
await typeInto("claude token", CLAUDE_TOKEN);
await clickText("Save token");
await waitText(/✅ Claude token/, 10000);
check("settings: saving the Claude token ticks the checklist", true);
check("settings: token field is cleared and the value is never rendered", !(await text()).includes(CLAUDE_TOKEN) && (await page.$eval('input[aria-label="claude token"]', (i) => i.value)) === "");

// ---- CLI secret (names only)
await typeInto("secret name", "NPM_TOKEN");
await typeInto("secret value", SECRET_VALUE);
await clickText("Save secret");
await waitText(/NPM_TOKEN/, 10000);
check("settings: secret name listed", true);
const html = await page.content();
const stored = JSON.stringify(await page.evaluate(() => ({ ...localStorage })));
check("settings: secret value is never in the DOM or localStorage", !html.includes(SECRET_VALUE) && !stored.includes(SECRET_VALUE) && !stored.includes(CLAUDE_TOKEN));
await typeInto("secret name", "lowercase");
await typeInto("secret value", "x");
await clickText("Save secret");
await waitText(/bad secret name/i, 10000);
check("settings: invalid secret name shows the backend error", true);

// ---- sleep minutes
await typeInto("sleep minutes", "7");
await clickText("Save");
await page.waitForFunction(() => document.querySelector('[data-testid="sleep-current"]')?.textContent === "7", { timeout: 10000 });
check("settings: sleep minutes saved", true);

// ---- GitHub callback: errors first (no OAuth app configured on the server, so a real-looking code is refused), then the sim bypass
await page.goto(`${WEB}/github/callback`, { waitUntil: "networkidle2" });
await waitText(/needs .*installation_id.*code/s, 10000);
check("callback: missing params explained", true);
await page.goto(`${WEB}/github/callback?installation_id=7&code=not-sim`, { waitUntil: "networkidle2" });
await page.waitForSelector('[data-testid="link-error"]', { timeout: 15000 });
const err = await page.$eval('[data-testid="link-error"]', (e) => e.textContent);
check("callback: not_configured is shown clearly", /not configured/i.test(err), err.slice(0, 90));
await page.goto(`${WEB}/github/callback?installation_id=7&code=sim&setup_action=install`, { waitUntil: "networkidle2" });
await page.waitForSelector('[data-testid="check-github"]', { timeout: 15000 });
await waitText(/✅ GitHub App installed/, 10000);
check("callback: sim code links the installation and lands on settings with the box ticked", page.url().endsWith("/settings"), page.url());
await waitText(/Ready: you can create dorks/, 5000);
await page.screenshot({ path: `${SHOTS}/settings-done.png` });

// ---- back on /dorks: no nudge; double-click creates exactly one dork
await page.click('a[href="/dorks"]');
await page.waitForSelector('input[aria-label="repo"]');
await sleep(500);
check("dorks: no onboarding nudge once complete", !/Setup is incomplete/.test(await text()));
await typeInto("first message", "build the settings demo");
await page.click('form button[type="submit"]', { count: 2, delay: 5 });
await waitText(/claude: w\d+/, 30000);
const midText = await text();
check("dorks: first turn streams live after UI-only onboarding", /claude: w\d+ w\d+/.test(midText), midText.match(/claude: [^\n]{0,50}/)?.[0]);
await page.screenshot({ path: `${SHOTS}/settings-streaming.png` });
await waitText(/Done: build the settings demo/, 40000);
await waitText(/\bidle\b/, 30000);
const listCount = await page.$$eval("main ul li", (li) => li.length);
check("dorks: double-click on New dork created one dork", listCount === 1, `${listCount} in list`);
check("dorks: Create is re-enabled after the request settles", !(await page.$eval('form button[type="submit"]', (b) => b.disabled)));

// ---- draft must not leak into another dork
await page.type('input[aria-label="message"]', "DRAFT-FOR-FIRST");
await typeInto("first message", "second dork");
await page.click('form button[type="submit"]');
await page.waitForFunction(() => document.querySelectorAll("main ul li").length === 2, { timeout: 15000 });
await page.waitForFunction(() => /second dork/.test(document.querySelector('section[aria-label="thread"] h2')?.innerText ?? ""), { timeout: 15000 });
const leaked = await page.$eval('section[aria-label="thread"] input[aria-label="message"]', (i) => i.value);
check("dorks: draft typed in one dork does not follow to the newly selected one", leaked === "", JSON.stringify(leaked));
check("settings-e2e: no page errors", errors.length === 0, errors[0]?.slice(0, 120));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
