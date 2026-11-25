import { z } from "zod";

// Secure inputs (docs/secure-inputs.md): an agent asks the owner for values it must use but should never read (a login, a password, a
// one-time code, an API key). The owner types them into a card in the chat; the agent only ever holds a reference, `{{secret:NAME}}`,
// which the bridge swaps for the value right before a tool runs and scrubs from everything the tool returns.

/** How a field is typed in the card: plain text, an email address, a masked secret, or a one-time code. The agent sees none of them. */
export const inputFieldKind = z.enum(["text", "email", "secret", "otp"]);
export type InputFieldKind = z.infer<typeof inputFieldKind>;

/** A value's name: what the agent writes in `{{secret:NAME}}`. Unique in a session; asking again under the same name replaces the value. */
export const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_INPUT_FIELDS = 8;
export const MAX_INPUT_VALUE = 8 * 1024;

export const inputField = z.object({
  name: z.string().regex(INPUT_NAME),
  label: z.string().min(1).max(80),
  kind: inputFieldKind,
  /** Shown under the label, e.g. "The 6-digit code from your authenticator app". */
  description: z.string().max(200).optional(),
  optional: z.boolean().optional(),
});
export type InputField = z.infer<typeof inputField>;

/** `{{secret:NAME}}` anywhere in a tool's input. */
export const SECRET_REF = /\{\{secret:([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
export const secretRef = (name: string) => `{{secret:${name}}}`;
