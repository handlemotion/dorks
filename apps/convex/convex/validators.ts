import { v } from "convex/values";

export const dorkState = v.union(v.literal("creating"), v.literal("working"), v.literal("idle"), v.literal("sleeping"), v.literal("waking"), v.literal("error"));
