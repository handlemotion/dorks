import { useEffect, useState, type ReactNode } from "react";
import { Tip } from "../Tip";
import { BadIcon, CopiedIcon, CopyIcon, GoodIcon, ReplyIcon } from "./icons";

/**
 * A message's hover toolbar, ported from aicss's Message Actions (https://www.aicss.dev/components/message-actions): same behaviour,
 * geometry and motion, its CSS module rewritten as Tailwind on the app's tokens. Where the app's rules differ, the rules win: the
 * app's own Tip tooltip, 12px text, 6px controls, no shadow (the hairline border is the reference's, kept on request). Rate (a final
 * answer only), copy and reply: no reactions, no More menu. `HoverActions` places it on a message, with its time in the left gutter.
 */

const BUTTON =
  "relative inline-flex size-5 cursor-pointer items-center justify-center rounded-(--control-radius) border-0 bg-transparent p-0 text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.04] focus-visible:text-foreground data-[on=true]:bg-foreground/[0.07] data-[on=true]:text-foreground";

/** Each glyph names its own transform origin (aicss's default is 50% 82%). */
const GLYPH = "block size-3";

/** Joins class names; no merging, so no two of them may set the same property. */
const cn = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(" ");

type Vote = "up" | "down" | null;

function formatAbsolute(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "4:17": the clock time alone, short enough for the transcript's 30px gutter. The tooltip carries the date. */
function formatClock(date: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .formatToParts(date)
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
}

export function MessageActions({
  text,
  rate,
  onCopy,
  onVote,
  onReply,
}: {
  /** What Copy puts on the clipboard. */
  text: string;
  /** Show Good / Bad response (the agent's final answers). */
  rate?: boolean;
  onCopy?: (text: string) => void;
  onVote?: (vote: Vote) => void;
  onReply?: () => void;
}) {
  const [vote, setVote] = useState<Vote>(null);
  const [copied, setCopied] = useState(false);
  const [upN, setUpN] = useState(0);
  const [downN, setDownN] = useState(0);
  const [replyN, setReplyN] = useState(0);
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

  return (
    <div
      data-testid="message-actions"
      className="relative inline-flex items-center gap-0.5 rounded-(--control-radius) border border-border bg-surface p-px"
    >
      {rate && <>
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
      </>}

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

      {onReply && (
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
      )}
    </div>
  );
}

/**
 * A message with its toolbar and time: hidden until the pointer is over the message or focus is in it, then the toolbar at its
 * top-right corner, just above it (24px tall, 4px clear of the text), and the time left of its first line, centered in the 40px gutter: the transcript is inset 20px
 * more than the composer, so the time's center falls on the composer's left edge. The message's scroller item paints with
 * `content-visibility: auto`, which clips what is pulled outside it, so the items keep room above and left of it (see ChatBlock).
 */
export function HoverActions({
  children,
  className,
  sentAt,
  timeClassName,
  ...actions
}: Parameters<typeof MessageActions>[0] & {
  children: ReactNode;
  className?: string;
  /** When the message was sent: its clock time shows in the left gutter on hover. */
  sentAt?: Date;
  /** Moves the time down to the message's first line (a bubble's padding). */
  timeClassName?: string;
}) {
  return (
    <div data-testid="hover-actions" className={cn("group/msg relative min-w-0", className)}>
      {sentAt && (
        <span
          className={cn(
            "absolute top-0 right-full flex h-[1lh] w-10 items-center justify-center opacity-0 transition-opacity duration-150 ease-out group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 motion-reduce:transition-none",
            timeClassName,
          )}
        >
          <Tip label={formatAbsolute(sentAt)}>
            <time
              dateTime={sentAt.toISOString()}
              className="cursor-default text-xs whitespace-nowrap text-muted-foreground tabular-nums"
            >
              {formatClock(sentAt)}
            </time>
          </Tip>
        </span>
      )}
      {children}
      <div className="pointer-events-none absolute right-0 bottom-full z-10 mb-1 opacity-0 transition-opacity duration-150 ease-out group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 motion-reduce:transition-none">
        <MessageActions {...actions} />
      </div>
    </div>
  );
}
