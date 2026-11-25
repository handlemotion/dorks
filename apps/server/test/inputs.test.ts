import { describe, expect, it } from "vite-plus/test";
import { AppFail } from "../src/app";
import { answerInput, inputValues, requestInput, waitInput } from "../src/services/inputs";
import { harness } from "./harness";

// Secure inputs (docs/secure-inputs.md): the owner's values reach only the session's bridge; no event, row in clear or answer holds one.

const code = async (f: () => unknown) => {
  try {
    await f();
  } catch (e) {
    return e instanceof AppFail ? e.error.code : "thrown";
  }
  return "ok";
};

const fields = [
  { name: "login", label: "Email", kind: "email" },
  { name: "password", label: "Password", kind: "secret" },
  { name: "note", label: "Note", kind: "text", optional: true },
];

describe("secure inputs", () => {
  it("stores the owner's values encrypted, for the bridge only, and never in the transcript", async () => {
    const h = harness();
    const dork = h.seed("working");
    const password = " hunter2's $ecret ";

    const r = requestInput(h.app, dork, { title: "Page login", description: "To post as the page.", fields });
    expect(r.status).toBe("pending");
    expect(await code(() => requestInput(h.app, dork, { title: "Again", fields }))).toBe("conflict"); // one at a time

    // Required fields are required, unknown ones refused; nothing is stored by a refused answer.
    expect(await code(() => answerInput(h.app, dork, r.requestId, { values: { login: "me@example.com" } }))).toBe("invalid");
    expect(await code(() => answerInput(h.app, dork, r.requestId, { values: { login: "a@b.c", password: "x", other: "y" } }))).toBe("invalid");
    expect((await inputValues(h.app, dork)).values).toEqual({});

    await answerInput(h.app, dork, r.requestId, { values: { login: " me@example.com ", password, note: "" } });
    expect(await waitInput(h.app, dork, r.requestId, 0)).toEqual({ requestId: r.requestId, status: "provided", names: ["login", "password"], refs: ["{{secret:login}}", "{{secret:password}}"] });
    expect((await inputValues(h.app, dork)).values).toEqual({ login: "me@example.com", password }); // a secret is kept exactly as typed
    expect(await code(() => answerInput(h.app, dork, r.requestId, { dismiss: true }))).toBe("conflict");

    // Nothing at rest or in the transcript holds a value.
    const dump = JSON.stringify([h.events(dork), h.app.db.all("SELECT * FROM input_values"), h.app.db.all("SELECT * FROM input_requests")]);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("me@example.com");
    expect(h.events(dork).at(-1)!.body).toMatchObject({ type: "input_response", status: "provided", names: ["login", "password"] });

    // Asking again under a name replaces its value (a new one-time code); a dismissal keeps the old ones.
    const otp = requestInput(h.app, dork, { title: "Code", fields: [{ name: "password", label: "Code", kind: "otp" }] });
    await answerInput(h.app, dork, otp.requestId, { values: { password: "123456" } });
    expect((await inputValues(h.app, dork)).values.password).toBe("123456");
    const later = requestInput(h.app, dork, { title: "Key", fields: [{ name: "key", label: "Key", kind: "secret" }] });
    await answerInput(h.app, dork, later.requestId, { dismiss: true });
    expect(await waitInput(h.app, dork, later.requestId, 0)).toEqual({ requestId: later.requestId, status: "dismissed" });
    expect(Object.keys((await inputValues(h.app, dork)).values).sort()).toEqual(["login", "password"]);
  });

  it("refuses malformed requests", async () => {
    const h = harness();
    const dork = h.seed("working");
    expect(await code(() => requestInput(h.app, dork, { title: "x", fields: [] }))).toBe("invalid");
    expect(await code(() => requestInput(h.app, dork, { title: "x", fields: [{ name: "1bad", label: "x", kind: "text" }] }))).toBe("invalid");
    expect(await code(() => requestInput(h.app, dork, { title: "x", fields: [fields[0], fields[0]] }))).toBe("invalid");
  });
});
