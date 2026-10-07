// The bridge handles three kinds of secrets: the per-dork bridge secret, the GitHub token, and the CLI env (Claude OAuth token +
// user CLI secrets). None may be logged or sent anywhere except where the protocol says. Everything user-visible goes through here.
const MIN_LEN = 6; // shorter values would shred ordinary words ("1", "true"); real secrets are longer

export class Redactor {
  private secrets = new Set<string>();

  add(value: string | undefined | null) {
    if (value && value.length >= MIN_LEN) this.secrets.add(value);
  }

  addAll(values: Iterable<string>) {
    for (const v of values) this.add(v);
  }

  /** Replaces every known secret value (longest first, so a secret containing another is fully masked). */
  scrub(text: string): string {
    let out = text;
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
    return out;
  }
}

/** Fixed-vocabulary logger: callers pass short messages and non-secret fields; errors are reduced to their name/code. */
export function makeLogger(tag: string, redactor: Redactor, sink: (line: string) => void = (l) => console.log(l)) {
  return (...parts: unknown[]) => sink(`[bridge ${tag}] ${redactor.scrub(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "))}`);
}
export type Log = ReturnType<typeof makeLogger>;

/** A short, safe description of a thrown value: never the message of arbitrary errors (they can echo env). */
export function errTag(e: unknown): string {
  const x = e as { data?: { code?: unknown }; code?: unknown; name?: unknown } | null;
  const code = x?.data?.code ?? x?.code;
  return typeof code === "string" ? code : typeof x?.name === "string" ? x.name : "error";
}
