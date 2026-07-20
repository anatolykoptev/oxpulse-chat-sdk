/**
 * @oxpulse/intro-protocol — L2 introduction protocol (bounded context).
 *
 * ADR-010: One package containing intro-crypto + intro-wire + intro-safety-number.
 * ADR-003: Flat public re-exports — no sub-path exports.
 *
 * EXPERIMENTAL (0.1.0). See SECURITY.md for the threat model and
 * constant-time invariants.
 */

// intro-crypto — Briar-faithful crypto primitives (X25519+HKDF+AEAD, MAC/sig)
export {
  LABEL_SESSION_ID,
  LABEL_MASTER_KEY,
  LABEL_ALICE_MAC_KEY,
  LABEL_BOB_MAC_KEY,
  LABEL_AUTH_MAC,
  LABEL_AUTH_NONCE,
  LABEL_AUTH_SIGN,
  LABEL_ACTIVATE_MAC,
  PROTOCOL_VERSION,
  deriveSessionId,
  isAliceRole,
  deriveMasterKey,
  deriveMacKeys,
  wipeMacKeys,
  wipe,
  buildAuthTranscript,
  computeAuthMac,
  verifyAuthMac,
  computeAuthSig,
  verifyAuthSig,
  computeActivateMac,
  verifyActivateMac,
  sealAead,
  openAead,
  envelopeToWireB64u,
  wireB64uToEnvelope,
  type TranscriptParty,
  type AeadEnvelope,
  type AeadLabel,
} from './intro-crypto.ts';

// intro-wire — JSON+Zod wire codec for the 6 intro message types
export {
  IntroRequestV1Schema,
  IntroAcceptV1Schema,
  IntroDeclineV1Schema,
  IntroAuthV1Schema,
  IntroActivateV1Schema,
  IntroAbortV1Schema,
  IntroMessageSchema,
  encodeIntroMessage,
  decodeIntroMessage,
  verifySessionIdRedundancy,
  type IntroMessage,
  type IntroKind,
} from './intro-wire.ts';

// intro-safety-number — Signal-style safety number (SAS) derivation
export { deriveSafetyNumber } from './intro-safety-number.ts';
