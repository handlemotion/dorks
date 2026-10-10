import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("sweep rate limit counters", { hours: 6 }, internal.rateLimit.sweep, {});
crons.interval("sweep github deliveries and delivered inbox rows", { hours: 6 }, internal.subscriptions.sweep, {});
crons.interval("meter box usage to Stripe", { minutes: 10 }, internal.billing.meterAll, {});
crons.interval("sweep stripe events and closed usage rows", { hours: 6 }, internal.billing.sweep, {});
export default crons;
