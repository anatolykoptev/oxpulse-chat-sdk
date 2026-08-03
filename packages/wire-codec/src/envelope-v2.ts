// wire-envelope-v2.ts — Phase 2.F.A envelope compaction registry + transforms.
//
// Saves ~33 B per envelope by replacing wasteful field encodings:
//   id    — 36-char UUID string  → 16-byte raw Uint8Array  (-21 B)
//   ts    — absolute ms uint64   → uint32 ms-since-ROOM_EPOCH (-4 B)
//   kind  — 9-char ASCII string  → uint8 enum index (k)     (-8 B)
//   from  — STAYS as 64-char hex string (Phase 2.F.B will replace).
//
// Wire shape change (inside zstd-of-CBOR):
//   v1: { v: 1, id: string, ts: number, from: string, kind: string, body: ..., ... }
//   v2: { v: 2, id: Uint8Array(16), ts: uint32, from: string, k: uint8, body: ..., ... }
//
// All other fields pass through unchanged (body, nick, sig, replyTo, attachments, …).
// The v1 wire shape — incl. `kind: string`, `id: string`, absolute `ts` — is what
// every consumer above the wire layer expects; transforms here are invisible above.
//
// ROOM_EPOCH is a fixed constant (NOT negotiated). Keeps the wire deterministic
// across rooms and tabs. uint32 ms = ~49.7 days range — comfortably covers a
// burner-chat session. Encoder falls back to v1 if `ts` is outside the window.
//
// Kind enum (0x01..0x4F, stable wire IDs — never renumber):
//   0x01..0x08  chat-*             (chat-msg .. chat-history-request)
//   0x10..0x1F  pay-* (LN/BOLT-12)
//   0x20..0x2F  cashu-*
//   0x30..0x3F  evm-pay-*
//   0x40..0x4F  xmr-pay-*
//
// T3 — forward-compat: fromV2 never throws on an unknown k byte.
//   Unknown k → { kind: "chat-unknown-future", raw: k, ... }.
//   Callers must handle this sentinel (log + drop); they MUST NOT originate it.
//   "chat-unknown-future" is intentionally absent from KIND_TO_BYTE so toV2
//   rejects it both at the type level (ChatKindEncodable) and at runtime.

/** 2026-01-01 00:00 UTC. Inviolable: changing this breaks v2 wire compat. */
export const ROOM_EPOCH = 1_767_225_600_000;

/** Stable wire IDs for envelope-v2 `k` byte. Never renumber existing entries. */
export const KIND_TO_BYTE: Readonly<Record<string, number>> = Object.freeze({
	"chat-msg": 0x01,
	"chat-edit": 0x02,
	"chat-delete": 0x03,
	"chat-reaction": 0x04,
	"chat-receipt": 0x05,
	"chat-typing": 0x06,
	"chat-history": 0x07,
	"chat-history-request": 0x08,
	// pay-* (LN / BOLT-12)
	"pay-quote-request": 0x10,
	"pay-quote": 0x11,
	"pay-paid": 0x12,
	"pay-confirmed": 0x13,
	"pay-cancel": 0x14,
	"pay-offer-publish": 0x15,
	"pay-offer-pay-request": 0x16,
	// cashu-*
	"cashu-token-send": 0x20,
	"cashu-token-claim": 0x21,
	"cashu-token-bounce": 0x22,
	// evm-pay-*
	"evm-pay-quote-request": 0x30,
	"evm-pay-quote": 0x31,
	"evm-pay-paid": 0x32,
	"evm-pay-confirmed": 0x33,
	"evm-pay-cancel": 0x34,
	// xmr-pay-*
	"xmr-pay-quote-request": 0x40,
	"xmr-pay-quote": 0x41,
	"xmr-pay-paid": 0x42,
	"xmr-pay-confirmed": 0x43,
	"xmr-pay-cancel": 0x44,
});

export const BYTE_TO_KIND: Readonly<Record<number, string>> = Object.freeze(
	Object.fromEntries(Object.entries(KIND_TO_BYTE).map(([k, v]) => [v, k])),
);

/**
 * The set of kind strings that toV2 accepts for encoding.
 * "chat-unknown-future" is intentionally excluded — it is a receive-only sentinel
 * that must never be originated by this client.
 */
export type ChatKindEncodable = keyof typeof KIND_TO_BYTE;

/** Parse a 36-char UUID string into 16 raw bytes. Returns null on malformed input. */
export function uuidToBytes(s: string): Uint8Array | null {
	if (typeof s !== "string" || s.length !== 36) return null;
	const hex = s.replace(/-/g, "");
	if (hex.length !== 32) return null;
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(b)) return null;
		out[i] = b;
	}
	return out;
}

/** Format 16 raw bytes as a 36-char UUID string (8-4-4-4-12). */
export function bytesToUuid(bytes: Uint8Array): string {
	if (bytes.length !== 16) throw new Error("wire-envelope-v2: UUID must be 16 bytes");
	const hex: string[] = new Array(16);
	for (let i = 0; i < 16; i++) hex[i] = bytes[i]!.toString(16).padStart(2, "0");
	return (
		hex.slice(0, 4).join("") + "-" +
		hex.slice(4, 6).join("") + "-" +
		hex.slice(6, 8).join("") + "-" +
		hex.slice(8, 10).join("") + "-" +
		hex.slice(10, 16).join("")
	);
}

/** Decision: an event is v2-encodable iff every compact field fits.
 *  Misses (unknown kind, bad UUID, ts out of uint32-since-EPOCH window) → caller
 *  falls back to v1 envelope for THIS frame. Opportunistic per-frame, no wire break. */
export function canEncodeAsV2(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const o = value as Record<string, unknown>;
	if (typeof o.kind !== "string" || KIND_TO_BYTE[o.kind] === undefined) return false;
	if (typeof o.id !== "string" || uuidToBytes(o.id) === null) return false;
	if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return false;
	const delta = o.ts - ROOM_EPOCH;
	if (delta < 0 || delta > 0xffff_ffff) return false;
	return true;
}

/**
 * Transform v1-shape → v2-shape (compact).
 *
 * Caller MUST check canEncodeAsV2 first OR ensure kind is a ChatKindEncodable.
 * Throws at runtime if kind is not in KIND_TO_BYTE (catches "chat-unknown-future"
 * and any other non-encodable string at the send boundary).
 */
export function toV2(v1: Record<string, unknown>): Record<string, unknown> {
	const kByte = KIND_TO_BYTE[v1.kind as string];
	if (kByte === undefined) {
		throw new Error(`wire-envelope-v2: cannot encode kind "${String(v1.kind)}" — not a known wire kind`);
	}
	const idBytes = uuidToBytes(v1.id as string)!;
	const out: Record<string, unknown> = { ...v1 };
	delete out.kind;
	out.v = 2;
	out.id = idBytes;
	out.ts = (v1.ts as number) - ROOM_EPOCH;
	out.k = kByte;
	return out;
}

/**
 * Transform v2-shape → v1-shape (consumer-facing).
 *
 * T3 forward-compat: unknown k byte no longer throws. Instead returns the object
 * with kind="chat-unknown-future" and raw=k so the caller can log and drop without
 * crashing the entire receive pipeline. This is the critical receive-resilience
 * property: a client on protocol v(N) silently tolerates frames from v(N+1).
 *
 * Still throws for structurally invalid frames (bad id, out-of-window ts) since
 * those indicate corruption or a hostile sender, not a forward-compat scenario.
 */
export function fromV2(v2: Record<string, unknown>): Record<string, unknown> {
	const k = v2.k;
	const idRaw = v2.id;
	if (!(idRaw instanceof Uint8Array) || idRaw.length !== 16) {
		throw new Error("wire-envelope-v2: id must be 16-byte Uint8Array");
	}
	const tsDelta = v2.ts;
	if (typeof tsDelta !== "number" || !Number.isFinite(tsDelta) || tsDelta < 0 || tsDelta > 0xffff_ffff) {
		throw new Error("wire-envelope-v2: ts out of uint32 window");
	}
	const out: Record<string, unknown> = { ...v2 };
	delete out.k;
	out.v = 1;
	out.id = bytesToUuid(idRaw);
	out.ts = tsDelta + ROOM_EPOCH;

	if (typeof k !== "number") {
		// Structural corruption — missing or non-numeric kind field.
		// NOT a forward-compat scenario; throw so the caller can treat this as
		// a decode error (same class as bad id or out-of-window ts).
		// TODO: replace plain Error with WireCodecError("CORRUPT_V2_FRAME", ...)
		// once T1's error-code union lands and avoids a cross-PR race.
		throw new Error(`wire-envelope-v2: fromV2: missing or non-numeric kind byte (got ${typeof k})`);
	}
	if (BYTE_TO_KIND[k] === undefined) {
		// Forward-compat: numeric k byte allocated in a future protocol version.
		// Return sentinel so callers can log + drop without crashing.
		out.kind = "chat-unknown-future";
		out.raw = k;
		return out;
	}

	out.kind = BYTE_TO_KIND[k];
	return out;
}

// ─── Phase 2.F.B: envelope-v3 (peer-index compaction) ──────────────────────
//
// v3 = v2 + replace `from` (64-char hex pubkey string) with `f` (uint8 peer-index).
// Saves ~64 B/msg — the biggest single wire win in the ladder.
//
// Wire shape (inside zstd-of-CBOR):
//   v3: { v: 3, id: Uint8Array(16), ts: uint32, f: uint8, k: uint8, body, ... }
//
// The peer-index is the same uint8 already carried in the SFrame AEAD header
// (| epoch(4B) | peerIndex(1B) | ctr(8B) |). v3 just mirrors it INSIDE the
// ciphertext envelope so the receiver can resolve `from` → pubkey via the
// ratchet's peer_index_map without the 64-char hex string on the wire.
//
// A passive observer already sees peerIndex in the SFrame header (cleartext
// AAD), so mirroring it inside the ciphertext leaks nothing new.
//
// Forward-compat: fromV3 with an unknown `f` (peer not in map) returns
// `from: undefined` + `f: byte` so the caller can log + drop without crashing.
// This mirrors the v2 `chat-unknown-future` sentinel pattern.

/**
 * Decision: an event is v3-encodable iff it is v2-encodable AND `from` is a
 * non-empty string (the pubkey to replace) AND peerIndex is a valid uint8.
 * Misses → caller falls back to v2 (then v1) for THIS frame.
 * Opportunistic per-frame, no wire break.
 */
export function canEncodeAsV3(
	value: unknown,
	peerIndex: number,
): value is Record<string, unknown> {
	if (!canEncodeAsV2(value)) return false;
	if (!Number.isInteger(peerIndex) || peerIndex < 0 || peerIndex > 0xff) return false;
	const o = value as Record<string, unknown>;
	if (typeof o.from !== "string" || o.from.length === 0) return false;
	return true;
}

/**
 * Transform v1-shape → v3-shape (compact, with peer-index).
 *
 * Caller MUST check canEncodeAsV3 first. Throws if kind is not in KIND_TO_BYTE
 * or peerIndex is out of uint8 range.
 *
 * Replaces:
 *   `from: string` (64-char hex pubkey) → `f: uint8` (peer-index)
 *   `id: string` (UUID) → `id: Uint8Array(16)` (same as v2)
 *   `ts: number` (abs ms) → `ts: uint32` (same as v2)
 *   `kind: string` → `k: uint8` (same as v2)
 */
export function toV3(
	v1: Record<string, unknown>,
	peerIndex: number,
): Record<string, unknown> {
	if (!Number.isInteger(peerIndex) || peerIndex < 0 || peerIndex > 0xff) {
		throw new Error(`wire-envelope-v3: peerIndex must be uint8 (0..255), got ${peerIndex}`);
	}
	const kByte = KIND_TO_BYTE[v1.kind as string];
	if (kByte === undefined) {
		throw new Error(`wire-envelope-v3: cannot encode kind "${String(v1.kind)}" — not a known wire kind`);
	}
	const idBytes = uuidToBytes(v1.id as string)!;
	const out: Record<string, unknown> = { ...v1 };
	delete out.kind;
	delete out.from;
	out.v = 3;
	out.id = idBytes;
	out.ts = (v1.ts as number) - ROOM_EPOCH;
	out.k = kByte;
	out.f = peerIndex;
	return out;
}

/**
 * Transform v3-shape → v1-shape (consumer-facing).
 *
 * `resolvePeer` maps the uint8 peer-index back to the 64-char hex pubkey
 * string via the ratchet's epoch-specific peer_index_map. The `epoch`
 * parameter is threaded from DecodeOpts.epoch — it MUST be the
 * AEAD-authenticated epoch from the SFrame header, not the current epoch,
 * to prevent cross-epoch sender misattribution (UKS). See RFC 9420 §4.1.1.
 *
 * If resolvePeer is not provided, epoch is missing, or resolvePeer returns
 * undefined (peer not in map, epoch wiped), `from` is set to undefined and
 * `f` is preserved so the caller can log + drop.
 *
 * Forward-compat: unknown `k` byte → `kind: "chat-unknown-future"` + `raw: k`
 * (same sentinel as fromV2).
 *
 * Still throws for structurally invalid frames (bad id, out-of-window ts,
 * missing/non-numeric kind) — same as fromV2.
 */
export function fromV3(
	v3: Record<string, unknown>,
	epoch?: number,
	resolvePeer?: (epoch: number, peerIndex: number) => string | undefined,
): Record<string, unknown> {
	const k = v3.k;
	const idRaw = v3.id;
	const f = v3.f;
	if (!(idRaw instanceof Uint8Array) || idRaw.length !== 16) {
		throw new Error("wire-envelope-v3: id must be 16-byte Uint8Array");
	}
	const tsDelta = v3.ts;
	if (typeof tsDelta !== "number" || !Number.isFinite(tsDelta) || tsDelta < 0 || tsDelta > 0xffff_ffff) {
		throw new Error("wire-envelope-v3: ts out of uint32 window");
	}
	if (typeof f !== "number" || !Number.isInteger(f) || f < 0 || f > 0xff) {
		throw new Error(`wire-envelope-v3: f must be uint8 (0..255), got ${typeof f === "number" ? f : typeof f}`);
	}

	const out: Record<string, unknown> = { ...v3 };
	delete out.k;
	delete out.f;
	out.v = 1;
	out.id = bytesToUuid(idRaw);
	out.ts = tsDelta + ROOM_EPOCH;

	// Resolve peer-index → pubkey. The epoch is threaded from DecodeOpts —
	// it MUST be the AEAD-authenticated epoch from the SFrame header to prevent
	// cross-epoch sender misattribution. If resolver is missing, epoch is
	// missing, or resolver returns undefined (peer not in map, epoch wiped),
	// leave `from` undefined + preserve `f` for caller diagnostics. The caller
	// MUST handle `from === undefined` by dropping the frame (same as
	// chat-unknown-future).
	if (resolvePeer !== undefined && epoch !== undefined) {
		const pubkey = resolvePeer(epoch, f);
		if (pubkey !== undefined) {
			out.from = pubkey;
		} else {
			out.from = undefined;
			out.f = f; // preserve for caller diagnostics
		}
	} else {
		out.from = undefined;
		out.f = f; // preserve for caller diagnostics
	}

	if (typeof k !== "number") {
		throw new Error(`wire-envelope-v3: fromV3: missing or non-numeric kind byte (got ${typeof k})`);
	}
	if (BYTE_TO_KIND[k] === undefined) {
		// Forward-compat: numeric k byte allocated in a future protocol version.
		out.kind = "chat-unknown-future";
		out.raw = k;
		return out;
	}

	out.kind = BYTE_TO_KIND[k];
	return out;
}
