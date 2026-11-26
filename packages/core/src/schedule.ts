import type { ScheduleTrigger } from "@dorks/shared";

// When an automation's schedule fires next (docs/automations.md), in the trigger's own time zone, daylight saving included. Pure:
// epoch milliseconds in, epoch milliseconds out.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string) {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(timeZone, f);
  }
  return f;
}

export function validTimeZone(tz: string): boolean {
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `tz` at `ms`. */
function wall(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of format(tz).formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** How far `tz` is ahead of UTC at `ms`. */
function offset(ms: number, tz: string) {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` happens. A zone has at most two offsets around one day, so try both. A time that happens twice
 * (clocks go back) is the first one; a time skipped (clocks go forward) is read with the offset before the change, so it lands as far
 * past the gap as it was into it (02:30 on a 02:00 → 03:00 night is 03:30).
 */
function instant(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const before = offset(guess - DAY, tz);
  const after = offset(guess + DAY, tz);
  const hits = [guess - before, guess - after].filter((t) => {
    const w = wall(t, tz);
    return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
  });
  return hits.length ? Math.min(...hits) : guess - before;
}

/** The first time the schedule fires strictly after `after`. */
export function nextFire(t: Pick<ScheduleTrigger, "every" | "day" | "time" | "timezone">, after: number): number {
  const [h, mi] = t.time.split(":").map(Number);
  if (t.every === "hour") {
    // Hour by hour on the zone's wall clock, never by elapsed time: a change of offset that is not a whole hour (Lord Howe's 30
    // minutes) keeps the minute, and an hour the clocks skip is passed over.
    const now = wall(after, t.timezone);
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.UTC(now.y, now.mo - 1, now.d, now.h + i, mi));
      const fire = instant(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), mi, t.timezone);
      if (fire > after) return fire;
    }
    throw new Error("no next time"); // unreachable: a clock change is at most two hours
  }
  const today = wall(after, t.timezone);
  for (let i = 0; i < 9; i++) {
    // Calendar arithmetic on the date alone, then to an instant in the zone.
    const date = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
    const weekday = date.getUTCDay();
    if (t.every === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (t.every === "week" && weekday !== t.day) continue;
    const at = instant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi, t.timezone);
    if (at > after) return at;
  }
  throw new Error("no next time"); // unreachable: a week always has a match
}
