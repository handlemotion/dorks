import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { Schema } from "effect";
import type { App } from "../../app";
import { route } from "../route";

// What every UI API route module shares. Each module registers its routes on the one Hono app (ui.ts mounts them in order).

/** Registers a group of routes on the UI API. */
export type Routes = (api: Hono, app: App) => void;

/** The route handler builder bound to `app`. */
export const handler = (app: App) => (f: Parameters<typeof route>[1]) => route(app, f);

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Request bodies. A field a service checks itself (with its own message) stays `Unknown` here.
export const Loose = Schema.optional(Schema.Unknown);

export const str = (v: unknown) => v as string;

export const id = (c: Context) => c.req.param("id") as string;
export const name = (c: Context) => c.req.param("name") as string;
