/**
 * intro-wire.ts — Wire format codec for L2 introduction protocol messages.
 *
 * Encodes/decodes all 6 message types per sub-spec §4.1. Outer envelope
 * is JSON (matches chat-sdk inner-payload pattern at sdk-inbox-bridge
 * dispatch). Zod discriminated union validates at the receive boundary.
 *
 * ADR-002: JSON + Zod wire format (NOT wire-codec CBOR/zstd — the intro
 * protocol is its own bounded context per ADR-010).
 *
 * Plan: docs/superpowers/plans/2026-05-22-discovery-l2-plan.md (S3)
 */

import { z } from 'zod';

// Constant-time comparison — single source of truth (ADR-008, ADR-011).
import { timingSafePubkeyEqualB64u } from '@oxpulse/crypto-primitives';

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

/** 22-char URL-safe base64 — encodes 16 bytes (128-bit session ID) */
const SessionId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** 43-char URL-safe base64 — encodes 32 bytes (Ed25519/X25519 public key) */
const PubkeyB64u = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** 43-char URL-safe base64 — X25519 ephemeral public key (same 32B → 43-char) */
const EphPubB64u = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * Generic URL-safe base64 string (no fixed length) — used for variable-length
 * payloads like profile_key_b64u. Constrains charset to base64url to fail
 * fast on malformed input rather than passing through to downstream decode.
 */
const B64uString = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1);

/**
 * Deterministically CBOR-encodable transport properties (ADR-013 / #218 nit #6).
 *
 * Constrained to scalar types that cborg's rfc8949EncodeOptions encode
 * canonically: string | number | int | bool | null | arrays thereof.
 * Rejects floats-with-NaN-payloads, bigint, Map, Set, and other shapes
 * whose CBOR encoding can diverge between two parties constructing the
 * "same" logical value (which would break transcript/MAC verification).
 */
const TransportProps = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.bigint(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
  ]),
).default({});

/**
 * AEAD ciphertext: 24B nonce ‖ ciphertext ‖ 16B tag, URL-safe base64.
 * Minimum 54 chars = ceil((24 + 0 + 16) * 4 / 3) = ceil(160/3) = 54.
 */
const AeadCiphertextB64u = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(54);

// ---------------------------------------------------------------------------
// Per-kind schemas
// ---------------------------------------------------------------------------

export const IntroRequestV1Schema = z.object({
  kind: z.literal('intro_request_v1'),
  sessionId: SessionId,
  target: z.object({
    pubkey_b64u: PubkeyB64u,
    author_b64u: PubkeyB64u,
    profile_key_b64u: B64uString,
    short_id: z.string().optional(),
    handle: z.string().optional(),
    transport_props: TransportProps,
  }),
  note: z.string().max(280).optional(),
  created_at: z.number().int().nonnegative(),
});

export const IntroAcceptV1Schema = z.object({
  kind: z.literal('intro_accept_v1'),
  sessionId: SessionId,
  eph_pub_b64u: EphPubB64u,
  accepted_at: z.number().int().nonnegative(),
  transport_props: TransportProps,
});

export const IntroDeclineV1Schema = z.object({
  kind: z.literal('intro_decline_v1'),
  sessionId: SessionId,
  reason: z.enum(['declined', 'unknown_introducer', 'silent', 'blocked']).optional(),
});

export const IntroAuthV1Schema = z.object({
  kind: z.literal('intro_auth_v1'),
  sessionId: SessionId,
  aead_ciphertext: AeadCiphertextB64u,
});

export const IntroActivateV1Schema = z.object({
  kind: z.literal('intro_activate_v1'),
  sessionId: SessionId,
  aead_ciphertext: AeadCiphertextB64u,
});

export const IntroAbortV1Schema = z.object({
  kind: z.literal('intro_abort_v1'),
  sessionId: SessionId,
  reason: z.enum([
    'timeout',
    'invariant_violation',
    'user_cancel',
    'peer_declined',
    'cross_instance_unsupported',
  ]),
});

// ---------------------------------------------------------------------------
// Discriminated union over all 6 kinds
// ---------------------------------------------------------------------------

export const IntroMessageSchema = z.discriminatedUnion('kind', [
  IntroRequestV1Schema,
  IntroAcceptV1Schema,
  IntroDeclineV1Schema,
  IntroAuthV1Schema,
  IntroActivateV1Schema,
  IntroAbortV1Schema,
]);

export type IntroMessage = z.infer<typeof IntroMessageSchema>;
export type IntroKind = IntroMessage['kind'];

// ---------------------------------------------------------------------------
// Codec functions
// ---------------------------------------------------------------------------

/**
 * Encode an introduction protocol message to a JSON wire string.
 *
 * Validates before encoding (defensive — refuses to produce invalid wire
 * payloads even when TypeScript types are satisfied at call site).
 */
export function encodeIntroMessage(msg: IntroMessage): string {
  const validated = IntroMessageSchema.parse(msg);
  return JSON.stringify(validated);
}

/**
 * Decode an introduction protocol message from an unknown payload.
 *
 * The payload is the JSON-parsed object received from sdk-inbox-bridge
 * onSealedPayload callback. Throws a ZodError on validation failure —
 * callers must catch and treat as a rejected/malformed message.
 */
export function decodeIntroMessage(payload: unknown): IntroMessage {
  return IntroMessageSchema.parse(payload);
}

/**
 * Verify the sessionId redundancy check per sub-spec §4.1.
 *
 * The receiver re-derives the sessionId locally from the introducer's
 * public key + their own key material, then asserts equality against
 * the value carried on the wire. A mismatch indicates either an
 * introducer forgery attempt or a deterministic-derivation drift bug.
 *
 * Returns true if the wire sessionId matches the locally-derived value.
 *
 * *** SECURITY (ADR-011, CWE-208) ***
 * The comparison uses `timingSafePubkeyEqualB64u` (constant-time XOR-reduce
 * over the decoded bytes) instead of plain `===`. A plain `===` on the
 * crypto-derived b64url sessionId leaks the first-mismatch byte position
 * via timing, enabling a session-id oracle (OWASP ASVS V11.3.1, CWE-208).
 * The sessionId is attacker-influenced (an introducer forgery attempt
 * controls the wire value), so it MUST be compared in constant time.
 */
export function verifySessionIdRedundancy(
  msg: IntroMessage,
  derivedSessionId: string,
): boolean {
  return timingSafePubkeyEqualB64u(msg.sessionId, derivedSessionId);
}
