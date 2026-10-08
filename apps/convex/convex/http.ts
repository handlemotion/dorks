import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();
// Lazy: the auth is built per request, so a deploy (CI, fresh project) can precede `convex env set`; createAuth then fails fast on missing env.
authComponent.registerRoutesLazy(http, createAuth, { cors: true });
export default http;
