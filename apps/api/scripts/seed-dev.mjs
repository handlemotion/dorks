// Prints SQL that onboards a local dev user (encrypted fake Claude token + fake GitHub installation).
// Usage: node scripts/seed-dev.mjs <userId> | wrangler d1 execute DB --local --command "$(cat)"   (or use --file)
import { readFileSync } from "node:fs";
import { aad, encrypt, keyringFromEnv } from "../src/lib/crypto.ts";

const userId = process.argv[2];
const key = /^ENCRYPTION_KEY=(.+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!userId || !key) throw new Error("usage: seed-dev.mjs <userId>; needs ENCRYPTION_KEY in .dev.vars");
const enc = await encrypt(keyringFromEnv({ ENCRYPTION_KEY: key }), "sk-ant-oat01-dev-fake", aad.claudeToken(userId));
console.log(`INSERT OR REPLACE INTO user_settings (user_id, claude_token_enc, github_installation_id, key_version) VALUES ('${userId}', '${enc.value}', 1, ${enc.keyVersion});`);
