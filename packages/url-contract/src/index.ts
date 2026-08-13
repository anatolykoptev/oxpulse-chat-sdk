// ADR-0005 Wave 5 — @oxpulse/url-contract package.
// W5.2: constants + 3 URL-bearing brands (RoomId, ShortId, ShortLinkAlias).
// W5.3: Luhn mod-34 checksum (appendChecksum, verifyChecksum, CHECKSUM_ALPHABET).
// W5.4: canonical-short codec (parseRoomCode, RoomKind, RealKind, kindFromFirstLetter, isValidRoomId).
// W5.5: generators (generateRoomCode, generateOpaqueRoomId).
// room-ns: single authority for the client-side room segment (namespaceRoomSegment) —
//          `r:` SFU namespace prefix retired client-side; server still accepts it (DEBT D8).
export * from './constants.js';
export * from './brands.js';
export * from './checksum.js';
export * from './parse.js';
export * from './generators.js';
export * from './room-ns.js';
export * from './url.js';
