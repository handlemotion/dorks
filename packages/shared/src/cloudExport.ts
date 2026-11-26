import { z } from "zod";
import { AUTOMATION_MODES, automationTrigger } from "./automations";
import { commentPolicy } from "./autonomy";
import { buildRepo, buildService, machineType } from "./builds";
import { dorkState } from "./events";
import { DORK_MODES } from "./modes";

// "Move to cloud" (docs/move-to-cloud.md): a workspace leaves its owner's Mac for the cloud runtime (a team org that ran on the Mac, the
// personal workspace once it is on a paid plan, or the personal workspace copied into a paid team). The Mac's server exports what
// it has (sessions with their transcripts, builds, automations, MCP servers, skills, shared variables, settings) in this format, and
// uploads it to the cloud's import endpoint, which validates it with these same schemas (dorks-cloud imports @dorks/shared).
//
// Secret values never travel in clear: the import endpoint hands out an ECDH P-256 public key per import, and every secret is
// sealed to it (`sealForImport`): AES-256-GCM under a key derived from an ephemeral ECDH exchange (HKDF-SHA256, salt = the import
// id), with the org, the import and what the value is as additional data, so a sealed value cannot be moved to another name,
// org or import. The cloud opens them with `openImportSealed` and its private key.

export const CLOUD_EXPORT_FORMAT = "dorks-export";
export const CLOUD_EXPORT_VERSION = 1;
export const IMPORT_SEAL_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const id = z.string().min(1).max(128);
const ms = z.number().int().nonnegative();

/** A P-256 public key as JWK (the import endpoint's, or the export's ephemeral one). */
export const p256PublicJwk = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1) }).passthrough();
/** What the import endpoint answers on create: the key to seal secrets to. */
export const importKey = z.object({ kid: z.string().min(1).max(128), alg: z.literal(IMPORT_SEAL_ALG), jwk: p256PublicJwk });
export type ImportKey = z.infer<typeof importKey>;

/** One sealed secret: AES-GCM ciphertext (tag included) and its 12-byte IV, base64. */
export const sealedValue = z.object({ iv: b64, ct: b64 });
export type SealedValue = z.infer<typeof sealedValue>;

/** How the export's secrets are sealed: to which import key, with which ephemeral public key. */
export const exportSealing = z.object({ alg: z.literal(IMPORT_SEAL_ALG), kid: z.string().min(1).max(128), epk: p256PublicJwk });

/** A session (a dork): its row, without anything tied to this Mac (timers, bridge cursors, pending commands). */
export const exportSession = z.object({
  id,
  title: z.string().max(500),
  titleSource: z.enum(["message", "auto", "user"]),
  repo: z.string().max(200),
  branch: z.string().max(300),
  provider: z.enum(["claude", "codex", "opencode", "antigravity"]),
  mode: z.enum(DORK_MODES),
  /** As it was when exported: the Mac pauses every session first, so this is `sleeping` (or `error`, never awake). */
  state: dorkState,
  archived: z.boolean(),
  /** Boat sandbox id: on Teams (the org's own Boat key) the cloud resumes the same box; Cloud plans start a new one. */
  boxId: z.string().max(200).nullable(),
  /** The agent's own session, to resume it in that box. */
  claudeSessionId: z.string().max(200).nullable(),
  codexThreadId: z.string().max(200).nullable(),
  model: z.string().max(64).nullable(),
  effort: z.string().max(16).nullable(),
  fast: z.boolean(),
  codeMode: z.boolean(),
  /** The build it starts from (docs/builds.md), one of the manifest's `builds` (or null: the base machine). */
  buildId: z.string().max(64).nullable(),
  /**
   * Where it ran on the Mac (docs/local-dorks.md). A local session has no sandbox (`boxId` null): in the cloud its next message starts a
   * new one from the pushed branch; work never committed and pushed stays on the Mac.
   */
  location: z.enum(["cloud", "local"]).default("cloud"),
  parentId: id.nullable(),
  icon: z.string().max(16).nullable(),
  prUrl: z.string().max(500).nullable(),
  preview: z.string().max(500).nullable(),
  createdBy: z.object({ id: z.string().max(128), name: z.string().max(200) }).nullable(),
  createdAt: ms,
  lastActivityAt: ms,
  repliedAt: ms.nullable(),
  /** The transcript: `count` events numbered 1..lastSeq with no gap (seq is dense per session). */
  events: z.object({ count: z.number().int().nonnegative(), lastSeq: z.number().int().nonnegative() }),
});
export type ExportSession = z.infer<typeof exportSession>;

/** One transcript event as stored: its dense per-session seq, when it was appended, and the client event body. */
export const exportEvent = z.object({ seq: z.number().int().positive(), ts: ms, body: z.object({ type: z.string().min(1) }).passthrough() });
export type ExportEvent = z.infer<typeof exportEvent>;

export const exportAutomation = z.object({
  id,
  name: z.string().max(200),
  mode: z.enum(AUTOMATION_MODES),
  enabled: z.boolean(),
  triggers: z.array(automationTrigger),
  instructions: z.string(),
  model: z.string().max(64).nullable(),
  effort: z.string().max(16).nullable(),
  buildId: z.string().max(64).nullable(),
  createdAt: ms,
  updatedAt: ms,
});

/**
 * An MCP server. `secrets` seals {headers, env, url} (the full URL: hosted servers often carry a key in it; `url` here is redacted),
 * as `mcp|<name>`. OAuth sign-ins do not move (their tokens belong to this Mac's redirect): `oauth` says one must sign in again.
 */
export const exportMcpServer = z.object({
  name: z.string().min(1).max(64),
  transport: z.enum(["http", "stdio"]),
  url: z.string().max(2048).nullable(),
  command: z.string().max(2048).nullable(),
  args: z.array(z.string()),
  headerNames: z.array(z.string()),
  envNames: z.array(z.string()),
  oauth: z.boolean(),
  secrets: sealedValue,
  createdAt: ms,
});

/** A skill: its source and the folder as stored, gzipped JSON ([{path, data (base64), exec}]) in base64, with its sha256 digest. */
export const exportSkill = z.object({
  name: z.string().min(1).max(64),
  description: z.string(),
  repo: z.string().max(200),
  ref: z.string().max(200).nullable(),
  path: z.string().max(500),
  sha: z.string().max(64),
  digest: z.string().max(128),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  files: b64,
  installedAt: ms,
  updatedAt: ms,
});

/**
 * An image in a chat (a screenshot the agent shared, an image attached to a message): transcripts name it `dorks-image:<id>`, so it
 * keeps its id. The bytes are uploaded on their own (`PUT …/images/:id`, `exportImageData`).
 */
export const exportImage = z.object({ id: z.string().min(1).max(64), dorkId: id, mime: z.string().max(100), bytes: z.number().int().nonnegative(), createdAt: ms });
export const exportImageData = z.object({ mime: z.string().max(100), data: b64 });

/** A build variable: the value sealed as `build-var|<build id>|<name>`; null when an agent asked for it and nobody filled it in. */
export const exportBuildVar = z.object({ name: z.string().min(1).max(64), secret: z.boolean(), buildTime: z.boolean(), value: sealedValue.nullable() });

/**
 * A build (docs/builds.md): its definition and variables. The image does not move (it is a snapshot in the Mac's Boat account, and a
 * Dorks Cloud org builds on Dorks' own); `approved` says the owner had approved this exact spec, so the cloud may build it again.
 */
export const exportBuild = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  machineType,
  setupScript: z.string(),
  repos: z.array(buildRepo),
  services: z.array(buildService).default([]),
  approved: z.boolean(),
  /** It had an image on the Mac: worth building again in the cloud. */
  hadImage: z.boolean(),
  vars: z.array(exportBuildVar),
  createdAt: ms,
  updatedAt: ms,
});
export type ExportBuild = z.infer<typeof exportBuild>;

/** A shared variable (Settings › Shared variables): the value sealed as `variable|<name>`. */
export const exportVariable = z.object({ name: z.string().min(1).max(128), value: sealedValue });

/** Credentials that do not move; the cloud asks the owner for them again. */
export const REENTER = ["claudeToken", "boatKey", "sentryToken", "antigravityToken", "github"] as const;

export const exportSettings = z.object({
  sleepMinutes: z.number().positive(),
  /** Who may steer sessions from PR comments (docs/autonomy.md). */
  commentPolicy: commentPolicy.nullable(),
  claudeCodeMode: z.boolean(),
  boatOrg: z.string().max(200).nullable(),
  boatEnvironment: z.string().max(200).nullable(),
  sentryOrg: z.string().max(200).nullable(),
  sentryUrl: z.string().max(500).nullable(),
  /** Which of REENTER this Mac had set: the cloud prompts for exactly these. */
  reenter: z.array(z.enum(REENTER)),
});

/** Everything but the transcripts: what `PUT …/imports/:id/manifest` takes. */
export const exportManifest = z.object({
  format: z.literal(CLOUD_EXPORT_FORMAT),
  version: z.literal(CLOUD_EXPORT_VERSION),
  exportedAt: ms,
  /** The org this Mac served, and the import this export was made for (sealed values are bound to both). */
  orgId: id,
  importId: id,
  source: z.object({ kind: z.literal("mac"), macId: z.string().max(128).nullable(), app: z.string().max(64) }),
  sealing: exportSealing,
  settings: exportSettings,
  variables: z.array(exportVariable),
  mcpServers: z.array(exportMcpServer),
  skills: z.array(exportSkill),
  automations: z.array(exportAutomation),
  sessions: z.array(exportSession),
  images: z.array(exportImage),
  /** Builds, and the one new sessions start on. Absent in an export made before builds moved. */
  builds: z.array(exportBuild).default([]),
  defaultBuildId: z.string().max(64).nullable().default(null),
});
export type ExportManifest = z.infer<typeof exportManifest>;

/** The whole export as one file (`POST /api/cloud/export`): the manifest plus every session's events, by session id. */
/** The whole export as one file: the manifest, every session's events by session id, and every image's bytes (base64) by image id. */
export const exportFile = exportManifest.extend({ events: z.record(z.string(), z.array(exportEvent)), imageData: z.record(z.string(), b64) }).superRefine((f, ctx) => {
  for (const s of f.sessions) {
    const evs = f.events[s.id] ?? [];
    const dense = evs.length === s.events.count && evs.every((e, i) => e.seq === i + 1) && (evs.at(-1)?.seq ?? 0) === s.events.lastSeq;
    if (!dense) ctx.addIssue({ code: "custom", path: ["events", s.id], message: `expected ${s.events.count} events numbered 1..${s.events.lastSeq}` });
  }
  for (const k of Object.keys(f.events)) if (!f.sessions.some((s) => s.id === k)) ctx.addIssue({ code: "custom", path: ["events", k], message: "no such session" });
  for (const i of f.images) if (!(i.id in f.imageData)) ctx.addIssue({ code: "custom", path: ["imageData", i.id], message: "missing image bytes" });
});
export type ExportFile = z.infer<typeof exportFile>;

/** One upload of a session's events (`PUT …/sessions/:id/events`): consecutive seqs. */
export const exportEventsPart = z.object({ events: z.array(exportEvent).min(1).max(5000) });

/** `POST /v1/orgs/:orgId/imports`. */
export const importCreate = z.object({
  format: z.literal(CLOUD_EXPORT_FORMAT),
  version: z.literal(CLOUD_EXPORT_VERSION),
  source: z.object({ kind: z.literal("mac"), macId: z.string().max(128).nullable() }),
  counts: z.object({ sessions: z.number().int().nonnegative(), events: z.number().int().nonnegative() }),
});
export const importCreated = z.object({ importId: id, key: importKey, maxPartBytes: z.number().int().positive(), expiresAt: ms });
export type ImportCreated = z.infer<typeof importCreated>;

/** `POST …/imports/:id/commit` (200). */
export const importCommitted = z.object({
  runtime: z.literal("cloud"),
  sessions: z.number().int(),
  events: z.number().int(),
  /** The Mac left the org (a team org taken over); false when it stays (the personal workspace, or a copy into another org). */
  macRemoved: z.boolean().optional(),
});

// ---------------------------------------------------------------- sealing

const enc = new TextEncoder();
const toB64 = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const EC = { name: "ECDH", namedCurve: "P-256" } as const;
/** A JWK (the private one stays with the cloud). Not the DOM's `JsonWebKey`: this file also builds without DOM types. */
export type Jwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string; [k: string]: unknown };

/** The additional data a sealed value is bound to. `what` is `variable|<name>` or `mcp|<name>`. */
export const importAad = (orgId: string, importId: string, what: string) => `dorks-import-v1|${orgId}|${importId}|${what}`;

async function contentKey(priv: CryptoKey, pub: CryptoKey, importId: string, usage: "encrypt" | "decrypt") {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(importId), info: enc.encode("dorks-import-v1") }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}

/** The export side: one ephemeral key per export; `seal` encrypts one secret to the import key. */
export async function sealForImport(key: ImportKey, ctx: { orgId: string; importId: string }) {
  const pub = await crypto.subtle.importKey("jwk", key.jwk, EC, false, []);
  const eph = (await crypto.subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  const cek = await contentKey(eph.privateKey, pub, ctx.importId, "encrypt");
  const epk = (await crypto.subtle.exportKey("jwk", eph.publicKey)) as z.infer<typeof p256PublicJwk>;
  return {
    sealing: { alg: IMPORT_SEAL_ALG, kid: key.kid, epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y } } as z.infer<typeof exportSealing>,
    async seal(what: string, plaintext: string): Promise<SealedValue> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(importAad(ctx.orgId, ctx.importId, what)) }, cek, enc.encode(plaintext));
      return { iv: toB64(iv), ct: toB64(ct) };
    },
  };
}

/** The import side (the cloud): opens the export's sealed values with the import's private key (JWK). */
export async function openImportSealed(privateJwk: Jwk, manifest: Pick<ExportManifest, "orgId" | "importId" | "sealing">) {
  const priv = await crypto.subtle.importKey("jwk", privateJwk as never, EC, false, ["deriveBits"]);
  const epk = await crypto.subtle.importKey("jwk", manifest.sealing.epk, EC, false, []);
  const cek = await contentKey(priv, epk, manifest.importId, "decrypt");
  return async (what: string, v: SealedValue): Promise<string> =>
    new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(v.iv), additionalData: enc.encode(importAad(manifest.orgId, manifest.importId, what)) }, cek, fromB64(v.ct)));
}

/** A fresh import key pair (the cloud's side; also what tests use). */
export async function newImportKey(kid: string): Promise<{ key: ImportKey; privateJwk: Jwk }> {
  const pair = (await crypto.subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as z.infer<typeof p256PublicJwk>;
  return { key: { kid, alg: IMPORT_SEAL_ALG, jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } }, privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk };
}
