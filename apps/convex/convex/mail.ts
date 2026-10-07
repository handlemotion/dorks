// Sign-in code mail via Resend. RESEND_API_URL only exists so e2e can point at a local capture server.
export async function sendOtpMail(to: string, code: string) {
  const key = process.env.RESEND_API_KEY;
  const domain = process.env.ALLOWED_EMAIL_DOMAIN ?? "jaantonio.com";
  if (!key) throw new Error("RESEND_API_KEY not set"); // never fall back to logging the code
  const res = await fetch(process.env.RESEND_API_URL ?? "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "dorks" },
    body: JSON.stringify({ from: `dorks <auth@${domain}>`, to, subject: `Your dorks code: ${code}`, text: `Your sign-in code is ${code}. It expires in 5 minutes.` }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`); // never include body/key in logs
}
