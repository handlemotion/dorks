export interface Mailer {
  sendOtp(to: string, code: string): Promise<void>;
}

// Dev fallback when RESEND_API_KEY is empty: print the code instead of emailing it.
export const consoleMailer: Mailer = {
  async sendOtp(to, code) {
    console.log(`[dev mailer] OTP for ${to}: ${code}`);
  },
};

export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async sendOtp(to, code) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "dorks-api", // Resend returns 403 without a User-Agent
        },
        body: JSON.stringify({ from, to, subject: `Your dorks code: ${code}`, text: `Your sign-in code is ${code}. It expires in 5 minutes.` }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}`); // never include body/key in logs
    },
  };
}

export function createMailer(env: Pick<Env, "RESEND_API_KEY" | "ALLOWED_EMAIL_DOMAIN">): Mailer {
  return env.RESEND_API_KEY
    ? resendMailer(env.RESEND_API_KEY, `dorks <auth@${env.ALLOWED_EMAIL_DOMAIN}>`)
    : consoleMailer;
}
