// Bun only. `bun build --compile` embeds both files into the executable; this module is only ever imported under Bun
// (see assets.ts), and it fails to compile unless the bridge bundle was built first (`pnpm --filter @dorks/bridge build`),
// which is what scripts/build.ts does. There is deliberately no silent fallback to an empty bundle.
// `with { type: "file" }` makes the default export the embedded file's path; TypeScript has no types for that.
// @ts-ignore
import bridgePath from "../../../../infra/bridge/dist/cli.mjs" with { type: "file" };
// @ts-ignore
import installerPath from "../../../../infra/snapshot/boat-install.sh" with { type: "file" };

export const bridge = new Uint8Array(await Bun.file(bridgePath as string).arrayBuffer());
export const installer = await Bun.file(installerPath as string).text();
