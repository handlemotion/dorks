import { inputField, MAX_INPUT_FIELDS, MAX_INPUT_VALUE, secretRef, type InputField } from "@dorks/shared";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "../core/crypto";
import { getDork } from "../data";
import { insert, update } from "../db";
import { append, cancelTimer, setTimer } from "../lifecycle/dispatch";

// Secure inputs (docs/secure-inputs.md). The agent asks for values it must use but should never read: a login, a password, a one-time
// code, an API key. The chat shows a card; the owner types the values in. They are stored encrypted (one per name per session), handed
// only to that session's bridge over its authenticated socket, and never written to an event, a log or a response of the UI API. The
// agent gets back names: it writes `{{secret:NAME}}` and the bridge swaps in the value right before a tool runs.
//
// The request is a row like a local-access request (services/local.ts): the agent's tool call waits on it (`waitInput`, a short poll
// the bridge repeats), and an unanswered one expires (a durable `input:<id>` timer).

export const REQUEST_TTL_MS = 30 * 60_000;
export const MAX_WAIT_MS = 8_000;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 500;
const TIMER = "input:";

type Status = "pending" | "provided" | "dismissed" | "expired";

interface RequestRow {
  id: string;
  dork_id: string;
  title: string;
  description: string | null;
  fields: string;
  status: Status;
  expires_at: number;
}

/** What the agent's tool gets back: never a value, only the names it can use. */
export interface InputResultView {
  requestId: string;
  status: Status;
  names?: string[];
  refs?: string[];
}

const requestRow = (app: App, id: string) => app.db.get<RequestRow>("SELECT * FROM input_requests WHERE id = ?", id);
const fieldsOf = (r: RequestRow) => JSON.parse(r.fields) as InputField[];

const text = (v: unknown, what: string, max: number, required: boolean): string | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return required ? fail("invalid", `${what} is required.`) : undefined;
  if (typeof v !== "string") return fail("invalid", `${what} must be a string.`);
  if (v.length > max) fail("invalid", `${what} is longer than ${max} characters.`);
  return v.trim();
};

function parseFields(v: unknown): InputField[] {
  if (!Array.isArray(v) || v.length === 0) return fail("invalid", "fields must list at least one field.");
  if (v.length > MAX_INPUT_FIELDS) fail("invalid", `At most ${MAX_INPUT_FIELDS} fields in one request.`);
  const fields = v.map((f, i) => {
    const p = inputField.safeParse(f);
    if (!p.success)
      return fail(
        "invalid",
        `fields[${i}] needs a name (a letter, then letters, digits or _), a label and a kind (text, email, secret or otp); a description is at most 200 characters and a url is https.`,
      );
    return p.data;
  });
  if (new Set(fields.map((f) => f.name)).size !== fields.length) fail("invalid", "Field names must be unique.");
  return fields;
}

// ---------------------------------------------------------------- the agent's side (bridge op `input`)

/** The agent asks. One request at a time per session; only Claude Code agents, whose hooks can swap a reference for its value. */
export function requestInput(app: App, dorkId: string, args: Record<string, unknown>): InputResultView {
  const title = text(args.title, "title", MAX_TITLE, true)!;
  const description = text(args.description, "description", MAX_DESCRIPTION, false);
  const fields = parseFields(args.fields);
  const id = app.db.tx(() => {
    const dork = getDork(app.db, dorkId);
    if (!dork || dork.deleting) return fail("not_found", "This session no longer exists.");
    if (dork.provider !== "claude") return fail("invalid", "Secure inputs need a Claude Code agent: only its hooks can use a value without showing it.");
    const waiting = app.db.get<{ id: string }>("SELECT id FROM input_requests WHERE dork_id = ? AND status = 'pending'", dorkId);
    if (waiting) return fail("conflict", `Your earlier request (${waiting.id}) is still waiting for the owner. Wait for it with input_wait before asking again.`);
    const id = app.uuid();
    const now = app.now();
    insert(app.db, "input_requests", { id, dorkId, title, description: description ?? null, fields: JSON.stringify(fields), status: "pending", expiresAt: now + REQUEST_TTL_MS, createdAt: now });
    append(app, dorkId, { type: "input_request", requestId: id, title, ...(description ? { description } : {}), fields });
    setTimer(app, dorkId, TIMER + id, REQUEST_TTL_MS);
    touch(app, { t: "dorks" });
    touch(app, { t: "dork", dorkId });
    return id;
  });
  return { requestId: id, status: "pending" };
}

function resultView(app: App, r: RequestRow): InputResultView {
  if (r.status !== "provided") return { requestId: r.id, status: r.status };
  const names = app.db.all<{ name: string }>("SELECT name FROM input_values WHERE dork_id = ? AND request_id = ? ORDER BY name", r.dork_id, r.id).map((v) => v.name);
  return { requestId: r.id, status: r.status, names, refs: names.map(secretRef) };
}

/** The agent waits for the owner: returns once the request is answered, or after `waitMs` with its current status. */
export async function waitInput(app: App, dorkId: string, requestId: unknown, waitMs: unknown): Promise<InputResultView> {
  if (typeof requestId !== "string") return fail("invalid", "requestId is required.");
  const budget = typeof waitMs === "number" && Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), MAX_WAIT_MS) : MAX_WAIT_MS;
  const deadline = app.now() + budget;
  for (;;) {
    const r = requestRow(app, requestId);
    if (!r || r.dork_id !== dorkId) return fail("not_found", "There is no such request for this session.");
    if (r.status !== "pending" || app.now() >= deadline) return resultView(app, r);
    await app.sleep(250);
  }
}

/** Every value this session holds, decrypted, for its bridge only (over the authenticated socket). Never for a UI response. */
export async function inputValues(app: App, dorkId: string): Promise<{ values: Record<string, string> }> {
  const rows = app.db.all<{ name: string; value_enc: string }>("SELECT name, value_enc FROM input_values WHERE dork_id = ?", dorkId);
  const values: Record<string, string> = {};
  for (const r of rows) values[r.name] = await decrypt(app.ring, r.value_enc, aad.input(OWNER, dorkId, r.name));
  return { values };
}

// ---------------------------------------------------------------- the owner's side

/** The values the owner typed, checked against the request's fields: required ones present, nothing else, each within the limit. */
function checkValues(fields: InputField[], raw: unknown): Map<string, { kind: InputField["kind"]; value: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid", "values must be an object of field name to value.");
  const given = raw as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!fields.some((f) => f.name === k)) fail("invalid", `${k} is not a field of this request.`);
  const out = new Map<string, { kind: InputField["kind"]; value: string }>();
  for (const f of fields) {
    const v = given[f.name];
    if (v !== undefined && typeof v !== "string") fail("invalid", `${f.label} must be text.`);
    // A secret is kept exactly as typed (a password may start or end with a space); the rest lose stray whitespace.
    const value = typeof v === "string" ? (f.kind === "secret" ? v : v.trim()) : "";
    if (value.length > MAX_INPUT_VALUE) fail("invalid", `${f.label} is too long.`);
    if (!value) {
      if (!f.optional) fail("invalid", `${f.label} is required.`);
      continue;
    }
    out.set(f.name, { kind: f.kind, value });
  }
  return out;
}

/** The owner fills the card in (`values`) or dismisses it. Values are encrypted before the transaction that stores them. */
export async function answerInput(app: App, dorkId: string, requestId: string, body: { values?: unknown; dismiss?: unknown }) {
  const r = requestRow(app, requestId);
  if (!r || r.dork_id !== dorkId) return fail("not_found", "This request no longer exists.");
  if (r.status !== "pending") return fail("conflict", "This request was already answered.");
  if (body.dismiss === true) return app.db.tx(() => settle(app, requestId, "dismissed"));
  const values = checkValues(fieldsOf(r), body.values);
  const sealed = await Promise.all([...values].map(async ([name, v]) => ({ name, kind: v.kind, enc: (await encrypt(app.ring, v.value, aad.input(OWNER, dorkId, name))).value })));
  const expired = app.db.tx(() => {
    const now = requestRow(app, requestId);
    if (!now || now.status !== "pending") return fail("conflict", "This request was already answered.");
    if (now.expires_at <= app.now()) {
      settle(app, requestId, "expired");
      return true;
    }
    for (const s of sealed)
      app.db.run(
        `INSERT INTO input_values (dork_id, name, kind, value_enc, request_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (dork_id, name) DO UPDATE SET kind = excluded.kind, value_enc = excluded.value_enc, request_id = excluded.request_id, updated_at = excluded.updated_at`,
        dorkId,
        s.name,
        s.kind,
        s.enc,
        requestId,
        app.now(),
      );
    settle(
      app,
      requestId,
      "provided",
      sealed.map((s) => s.name),
    );
    return false;
  });
  if (expired) fail("conflict", "This request expired.");
}

function settle(app: App, requestId: string, status: Exclude<Status, "pending">, names?: string[]) {
  const r = requestRow(app, requestId);
  if (!r || r.status !== "pending") return;
  update(app.db, "input_requests", { id: r.id }, { status, decidedAt: app.now() });
  cancelTimer(app, r.dork_id, TIMER + r.id);
  if (getDork(app.db, r.dork_id)) append(app, r.dork_id, { type: "input_response", requestId: r.id, status, ...(names ? { names } : {}) });
  touch(app, { t: "dorks" });
  touch(app, { t: "dork", dorkId: r.dork_id });
}

/** The request's expiry timer fired (lifecycle/lifecycle.ts). */
export function expireInput(app: App, dorkId: string, timerName: string): boolean {
  if (!timerName.startsWith(TIMER)) return false;
  const r = requestRow(app, timerName.slice(TIMER.length));
  if (r && r.dork_id === dorkId && r.status === "pending") settle(app, r.id, "expired");
  return true;
}

/** The bridge op: `request` asks, `wait` waits for the owner, `values` hands the session's values to its bridge. */
export async function inputOp(app: App, dorkId: string, args: Record<string, unknown>): Promise<unknown> {
  if (args.action === "request") return requestInput(app, dorkId, args);
  if (args.action === "wait") return waitInput(app, dorkId, args.requestId, args.waitMs);
  if (args.action === "values") return inputValues(app, dorkId);
  return fail("invalid", "unknown input action");
}
