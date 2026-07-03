// @oxpulse/wire-codec — public surface.
// All symbols re-exported from the three codec modules.

export { WireCodecError } from './errors.ts';
export type { WireCodecErrorCode, WireCodecErrorDetail, WireCodecErrorDetails } from './errors.ts';

export type { WireCap, EncodeOpts } from './codec.ts';
export {
  ALL_CAPS,
  ensureWireCodecReady,
  encode,
  decode,
  canonicalizeEnvelope,
  isCborMagic,
  negotiateCap,
  negotiateDict,
  capToOpts,
  negotiateEnvelopeVersion,
  encodeHttpBody,
  decodeHttpBody,
} from './codec.ts';

export { asWireBytes, asHttpWireBytes, asSealedBytes } from "./brands.js";
export type { WireBytes, HttpWireBytes, SealedBytes } from "./brands.js";

export type { DictName, DictLoader } from './dicts.ts';
export {
  ALL_DICTS,
  DICT_NAME_TO_ID,
  DICT_ID_TO_NAME,
  loadDict,
  getDictBytes,
  setDictLoader,
  setDictBaseUrl,
} from './dicts.ts';

export type { ChatKindEncodable } from './envelope-v2.ts';
export {
  ROOM_EPOCH,
  KIND_TO_BYTE,
  BYTE_TO_KIND,
  uuidToBytes,
  bytesToUuid,
  canEncodeAsV2,
  toV2,
  fromV2,
} from './envelope-v2.ts';

export {
  encodeMeshBundle,
  decodeMeshBundle,
  meshBundleSignedRange,
  MESH_BUNDLE_MAGIC_V1,
  MESH_BUNDLE_VERSION,
  MESH_BUNDLE_MAX_BODY,
} from './mesh-bundle.ts';
export type { MeshBundleEncodeArgs, MeshBundleDecoded } from './mesh-bundle.ts';
export { asMeshBundleBytes } from './brands.ts';
export type { MeshBundleBytes } from './brands.ts';
