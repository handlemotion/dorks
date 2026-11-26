import { fetchMacRelease, type MacRelease } from "./release";

let built: Promise<MacRelease | null> | undefined;

/** The latest release when the site is built (pages show it until the Worker's /download.json answers); null offline. */
export function builtRelease(): Promise<MacRelease | null> {
  built ??= fetchMacRelease("latest").catch((error) => {
    console.warn("site: could not read the latest Dorks release", error);
    return null;
  });
  return built;
}
