import { useEffect, useRef, useState } from "react";
import { Tip } from "../Tip";
import { BadIcon, CopiedIcon, CopyIcon, GoodIcon, ReplyIcon } from "./icons";

/**
 * The action row under an agent's answer, ported from aicss's Message Actions (https://www.aicss.dev/components/message-actions):
 * same behaviour, geometry and motion, its CSS module rewritten as Tailwind on the app's tokens. Where the app's rules differ, the
 * rules win: the app's own Tip tooltip, 12px text, 6px controls. Rate, copy and reply only: no reactions, no More menu.
 */

const BUTTON =
  "relative inline-flex size-6 cursor-pointer items-center justify-center rounded-(--control-radius) border-0 bg-transparent p-0 text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.04] focus-visible:text-foreground data-[on=true]:bg-foreground/[0.07] data-[on=true]:text-foreground";

/** Each glyph names its own transform origin (aicss's default is 50% 82%). */
const GLYPH = "block size-3.5";

/** Joins class names; no merging, so no two of them may set the same property. */
const cn = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ");

type Vote = "up" | "down" | null;

const ROLL_MS = 400;

function elapsedMinutes(date: Date, now: number) {
  return Math.max(0, Math.round((now - date.getTime()) / 60000));
}

function formatAgo(date: Date, now = Date.now()) {
  const minutes = elapsedMinutes(date, now);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatAbsolute(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The minutes in "3m ago", each changed digit rolling up (or down) to its next value. */
function MinuteRoll({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(
      Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN
        ? "down"
        : "up",
    );
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = window.setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <span className="inline-flex">
      {Array.from({ length: chars.length }, (_, i) => {
        const previous = oldVal[i] ?? "";
        const next = chars[i] ?? "";
        if (!rolling || previous === next)
          return <span key={`${i}-${next}`}>{next}</span>;
        const top = dir === "down" ? next : previous;
        const bottom = dir === "down" ? previous : next;
        const lifted = dir === "down" ? !shifted : shifted;
        return (
          <span
            key={`${i}-${previous}-${next}-${dir}`}
            className="relative inline-block h-[1em] overflow-hidden align-[-0.05em] leading-[1em]"
          >
            <span
              className="flex flex-col transition-transform duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none [&>span]:h-[1em] [&>span]:leading-[1em]"
              style={{
                transform: lifted ? "translateY(-1em)" : "translateY(0)",
              }}
            >
              <span>{top}</span>
              <span>{bottom}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function MessageActions({
  text,
  sentAt,
  onCopy,
  onVote,
  onReply,
}: {
  /** What Copy puts on the clipboard. */
  text: string;
  sentAt?: Date;
  onCopy?: (text: string) => void;
  onVote?: (vote: Vote) => void;
  onReply?: () => void;
}) {
  const [vote, setVote] = useState<Vote>(null);
  const [copied, setCopied] = useState(false);
  const [upN, setUpN] = useState(0);
  const [downN, setDownN] = useState(0);
  const [replyN, setReplyN] = useState(0);
  const [postedAt] = useState(() => sentAt ?? new Date());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 900);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const choose = (next: Vote) => {
    const value = vote === next ? null : next;
    setVote(value);
    onVote?.(value);
    if (next === "up") setUpN((n) => n + 1);
    if (next === "down") setDownN((n) => n + 1);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* the drawn check still shows */
    }
    setCopied(true);
    onCopy?.(text);
  };

  const reply = () => {
    setReplyN((n) => n + 1);
    onReply?.();
  };

  const minutes = elapsedMinutes(postedAt, now);

  return (
    <div
      data-testid="message-actions"
      className="group/actions relative inline-flex items-center gap-0.5"
    >
      <Tip label="Good response">
        <button
          type="button"
          className={cn(
            BUTTON,
            "data-[on=true]:text-emerald-600 dark:data-[on=true]:text-emerald-400",
          )}
          data-on={vote === "up"}
          aria-pressed={vote === "up"}
          aria-label="Good response"
          onClick={() => choose("up")}
        >
          <GoodIcon
            key={upN}
            className={cn(
              GLYPH,
              "origin-[50%_82%]",
              upN > 0 && "motion-safe:animate-ma-thumb-up",
            )}
          />
        </button>
      </Tip>

      <Tip label="Bad response">
        <button
          type="button"
          className={cn(BUTTON, "data-[on=true]:text-destructive")}
          data-on={vote === "down"}
          aria-pressed={vote === "down"}
          aria-label="Bad response"
          onClick={() => choose("down")}
        >
          <BadIcon
            key={downN}
            className={cn(
              GLYPH,
              "origin-[50%_18%]",
              downN > 0 && "motion-safe:animate-ma-thumb-down",
            )}
          />
        </button>
      </Tip>

      <Tip label={copied ? "Copied" : "Copy message"}>
        <button
          type="button"
          className={BUTTON}
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={copy}
        >
          <span className="grid">
            <CopyIcon
              className={cn(
                GLYPH,
                "origin-[50%_82%] [grid-area:1/1]",
                copied
                  ? "opacity-0 transition-none"
                  : "opacity-100 transition-opacity duration-[220ms] ease-[ease] motion-reduce:transition-none",
              )}
            />
            <CopiedIcon
              drawing={copied}
              className={cn(
                GLYPH,
                "origin-[50%_82%] [grid-area:1/1] text-emerald-600 dark:text-emerald-400",
                copied
                  ? "opacity-100 transition-none"
                  : "opacity-0 transition-opacity duration-[220ms] ease-[ease] motion-reduce:transition-none",
              )}
            />
          </span>
        </button>
      </Tip>

      <Tip label="Reply">
        <button
          type="button"
          className={BUTTON}
          aria-label="Reply"
          onClick={reply}
        >
          <ReplyIcon
            key={replyN}
            className={cn(GLYPH, "origin-[50%_82%]", replyN > 0 && "ma-play")}
          />
        </button>
      </Tip>

      <Tip label={formatAbsolute(postedAt)}>
        <time
          dateTime={postedAt.toISOString()}
          className="ml-1 inline-flex h-6 cursor-default items-center text-xs leading-none whitespace-nowrap text-muted-foreground tabular-nums opacity-0 transition-opacity duration-200 ease-[ease] group-focus-within/actions:opacity-100 group-hover/actions:opacity-100 motion-reduce:transition-none"
        >
          {minutes >= 1 && minutes < 60 ? (
            <>
              <MinuteRoll value={String(minutes)} />m ago
            </>
          ) : (
            formatAgo(postedAt, now)
          )}
        </time>
      </Tip>
    </div>
  );
}
