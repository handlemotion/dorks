import { z } from "zod";

// Automations (docs/automations.md): instructions an agent runs on a schedule, or when something happens in a repository. Each run
// starts an ordinary session. These are the wire shapes shared by the server and the web client; the server validates for real.

export const MAX_AUTOMATIONS = 50;
export const MAX_TRIGGERS = 10;
export const MAX_AUTOMATION_NAME_CHARS = 60;
export const MAX_INSTRUCTIONS_CHARS = 20_000;
export const MAX_AUTHORS = 20;

const repoName = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, "Choose a repository for every trigger.")
  .refine((r) => r.split("/").every((s) => s !== "." && s !== ".."), "Choose a repository for every trigger.");

/** How often a schedule fires. `weekdays` is Monday to Friday. */
export const SCHEDULE_EVERY = ["hour", "day", "weekdays", "week"] as const;
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number];

/** What happened in a repository. Comments are conversation comments on an issue or a pull request. */
export const GITHUB_EVENTS = ["pr_opened", "pr_pushed", "pr_merged", "issue_opened", "comment"] as const;
export type GithubEvent = (typeof GITHUB_EVENTS)[number];

const login = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/, "not a GitHub login");

export const scheduleTrigger = z.object({
  kind: z.literal("schedule"),
  every: z.enum(SCHEDULE_EVERY),
  /** `week` only: 0 Sunday … 6 Saturday. */
  day: z.number().int().min(0).max(6).default(1),
  /** `HH:MM`, 24h, in `timezone`. `hour` uses only the minutes. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM"),
  /** An IANA zone, `Europe/Berlin`. */
  timezone: z.string().min(1).max(64),
  repo: repoName,
  /** The branch the session starts from; absent: the default branch. */
  branch: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\s~^:?*[\\]*$/, "not a valid branch name")
    .optional(),
});
export type ScheduleTrigger = z.infer<typeof scheduleTrigger>;

export const githubTrigger = z.object({
  kind: z.literal("github"),
  event: z.enum(GITHUB_EVENTS),
  repo: repoName,
  /** Only events by these logins (the PR's or issue's author, the comment's writer); empty: anyone. */
  authors: z.array(login).max(MAX_AUTHORS).default([]),
});
export type GithubTrigger = z.infer<typeof githubTrigger>;

export const automationTrigger = z.discriminatedUnion("kind", [scheduleTrigger, githubTrigger]);
export type AutomationTrigger = z.infer<typeof automationTrigger>;

export const automationInput = z.object({
  name: z.string().trim().min(1, "Name the automation.").max(MAX_AUTOMATION_NAME_CHARS, `Keep the name under ${MAX_AUTOMATION_NAME_CHARS} characters.`),
  enabled: z.boolean().default(true),
  triggers: z.array(automationTrigger).min(1, "Add a trigger.").max(MAX_TRIGGERS, `At most ${MAX_TRIGGERS} triggers.`),
  instructions: z.string().trim().min(1, "Write what the agent should do.").max(MAX_INSTRUCTIONS_CHARS, "The instructions are too long."),
  /** Claude's model and effort (one the agent reported); absent: the default a new session gets. */
  model: z.string().max(64).nullable().default(null),
  effort: z.string().max(16).nullable().default(null),
  /** The build sessions start on; null: the default build, else the base machine. */
  buildId: z.string().max(64).nullable().default(null),
});
export type AutomationInput = z.input<typeof automationInput>;
export type AutomationSpec = z.output<typeof automationInput>;

/** How a run started: its schedule, an event in a repository, or the owner's Run now. */
export type AutomationRunSource = "schedule" | "manual" | GithubEvent;
export type AutomationRunStatus = "started" | "failed" | "skipped";

export interface AutomationRunView {
  id: string;
  automationId: string;
  source: AutomationRunSource;
  /** One line on what started it: `#12 Fix the login form by @alice`. */
  summary: string;
  /** The pull request, issue or comment it is about. */
  url: string | null;
  repo: string | null;
  status: AutomationRunStatus;
  /** Why it failed or was skipped, written for a person. */
  error: string | null;
  /** The session it started; null when none, or once it was deleted. */
  dork: { id: string; title: string; state: string; archived: boolean } | null;
  createdAt: number;
}

export interface AutomationView extends AutomationSpec {
  id: string;
  /** When a schedule fires next; null without an active schedule. */
  nextRunAt: number | null;
  lastRun: AutomationRunView | null;
  /** Runs in the last 7 days. */
  recentRuns: number;
  /** Repositories its GitHub triggers cannot read, with why. */
  problems: { repo: string; message: string }[];
  /** Public repositories among its GitHub triggers: there, only events by listed people start runs. */
  publicRepos: string[];
  createdAt: number;
  updatedAt: number;
}
