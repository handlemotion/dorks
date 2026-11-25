/** The relay's origin (docs/mobile.md). EXPO_PUBLIC_CLOUD_URL points the app at another one (a local wrangler dev, a staging Worker). */
export const CLOUD_URL = (process.env.EXPO_PUBLIC_CLOUD_URL || "https://dorks-cloud.handle-473.workers.dev").replace(/\/+$/, "");
