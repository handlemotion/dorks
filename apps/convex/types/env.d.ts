// Lets the carried-over Worker files (crypto.ts, github.ts) typecheck unchanged: they only read these keys.
interface Env {
  ENCRYPTION_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}
