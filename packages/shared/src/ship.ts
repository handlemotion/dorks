import { z } from "zod";

// Post-merge shipping (docs/shipping.md): after a session's pull request merges, the server keeps following the merge commit (the
// workflows it starts, other apps' checks, commit statuses, deployments) and shows it as one Ship card in the transcript. Each change
// appends a `ship` event carrying the whole snapshot; clients keep the latest per ship.

/** One thing that ran because of the merge. `skipped`: cancelled or skipped, which says nothing about the code. */
export const shipStageState = z.enum(["pending", "running", "passed", "failed", "skipped"]);
export type ShipStageState = z.infer<typeof shipStageState>;

/** `workflow`: a GitHub Actions run; `migration`: a job or step in one whose name says it migrates; `check`: another app's check run; `status`: a commit status; `deployment`: a GitHub deployment (one per environment). */
export const shipStageKind = z.enum(["workflow", "migration", "check", "status", "deployment"]);
export type ShipStageKind = z.infer<typeof shipStageKind>;

export const shipStage = z.object({
  id: z.string(),
  kind: shipStageKind,
  name: z.string(),
  state: shipStageState,
  /** Where to look: the run, the check, the deployment's log. */
  url: z.string().optional(),
  /** A deployment's live URL. */
  environmentUrl: z.string().optional(),
  /** A few words: `Cancelled`, `with 1a2b3c4` (a later commit's deploy that includes this one). */
  detail: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type ShipStage = z.infer<typeof shipStage>;

/**
 * `watching`: still running or waiting for things to start; `shipped`: everything that ran passed; `failed`: something failed (the
 * server keeps watching for re-runs until the watch ends); `stalled`: still not done when the watch ended; `quiet`: nothing ran on the
 * merge commit.
 */
export const shipStatus = z.enum(["watching", "shipped", "failed", "stalled", "quiet"]);
export type ShipStatus = z.infer<typeof shipStatus>;

export const shipView = z.object({
  id: z.number().int(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
  baseRef: z.string(),
  /** The merge commit. */
  sha: z.string(),
  status: shipStatus,
  stages: z.array(shipStage),
  /** When the PR merged. */
  startedAt: z.number(),
  /** When the server stopped watching; absent while it watches. */
  endedAt: z.number().optional(),
});
export type ShipView = z.infer<typeof shipView>;
