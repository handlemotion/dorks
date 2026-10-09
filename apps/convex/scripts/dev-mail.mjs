// Local stand-in for Resend for `pnpm dev`: listens on :8899 (where scripts/dev-backend.sh points RESEND_API_URL) and prints
// each sign-in code to the terminal. Codes are short-lived dev values for a local deployment; nothing is sent anywhere.
import { inbox, startMockResend } from "./mock-resend.mjs";

await startMockResend();
console.log("[dev-mail] listening on http://127.0.0.1:8899; sign-in codes will appear here");
let seen = 0;
setInterval(() => {
  for (; seen < inbox.length; seen++) {
    const m = inbox[seen];
    console.log(`[dev-mail] ${m.to}: ${m.subject}`);
  }
}, 200);
