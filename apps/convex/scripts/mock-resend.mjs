// Local stand-in for api.resend.com: captures sent mail so e2e can read the OTP without it ever being logged.
import { createServer } from "node:http";
export const inbox = [];
export function startMockResend(port = 8899) {
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      // Any bearer token: the dev deployment carries Doppler's real RESEND_API_KEY, CI a throwaway one.
      if (!req.headers.authorization?.startsWith("Bearer ")) { res.writeHead(401).end(); return; }
      inbox.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "application/json" }).end('{"id":"mock"}');
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
export const codeFor = (email) => [...inbox].reverse().find((m) => m.to === email)?.text.match(/\b(\d{6})\b/)?.[1];
