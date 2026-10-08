/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as boxes from "../boxes.js";
import type * as bridge from "../bridge.js";
import type * as crons from "../crons.js";
import type * as dorks from "../dorks.js";
import type * as events from "../events.js";
import type * as github from "../github.js";
import type * as http from "../http.js";
import type * as lib_box from "../lib/box.js";
import type * as lib_bridgeAuth from "../lib/bridgeAuth.js";
import type * as lib_dispatch from "../lib/dispatch.js";
import type * as lib_githubEvents from "../lib/githubEvents.js";
import type * as lib_githubIngest from "../lib/githubIngest.js";
import type * as lib_githubInstall from "../lib/githubInstall.js";
import type * as lib_notify from "../lib/notify.js";
import type * as lib_notifyRender from "../lib/notifyRender.js";
import type * as lib_repo from "../lib/repo.js";
import type * as lib_subscriptions from "../lib/subscriptions.js";
import type * as lib_upstash from "../lib/upstash.js";
import type * as lifecycle from "../lifecycle.js";
import type * as mail from "../mail.js";
import type * as rateLimit from "../rateLimit.js";
import type * as settings from "../settings.js";
import type * as simbox from "../simbox.js";
import type * as subscriptions from "../subscriptions.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  boxes: typeof boxes;
  bridge: typeof bridge;
  crons: typeof crons;
  dorks: typeof dorks;
  events: typeof events;
  github: typeof github;
  http: typeof http;
  "lib/box": typeof lib_box;
  "lib/bridgeAuth": typeof lib_bridgeAuth;
  "lib/dispatch": typeof lib_dispatch;
  "lib/githubEvents": typeof lib_githubEvents;
  "lib/githubIngest": typeof lib_githubIngest;
  "lib/githubInstall": typeof lib_githubInstall;
  "lib/notify": typeof lib_notify;
  "lib/notifyRender": typeof lib_notifyRender;
  "lib/repo": typeof lib_repo;
  "lib/subscriptions": typeof lib_subscriptions;
  "lib/upstash": typeof lib_upstash;
  lifecycle: typeof lifecycle;
  mail: typeof mail;
  rateLimit: typeof rateLimit;
  settings: typeof settings;
  simbox: typeof simbox;
  subscriptions: typeof subscriptions;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
