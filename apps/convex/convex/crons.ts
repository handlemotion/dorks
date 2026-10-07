import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("sweep rate limit counters", { hours: 6 }, internal.rateLimit.sweep, {});
export default crons;
