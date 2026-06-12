// Tests for T3 — forward-compat unknown-kind sentinel in fromV2.
//
// Design:
//   - fromV2 must NOT throw when it encounters a k byte not in KIND_TO_BYTE.
//   - It must return { kind: "chat-unknown-future", raw: k, ... }.
//   - Known kinds must still round-trip through toV2 / fromV2 unchanged.
//   - toV2 must reject "chat-unknown-future" at the type level (and runtime).

import { describe, it, expect } from "vitest";
import {
	fromV2,
	toV2,
	ROOM_EPOCH,
	KIND_TO_BYTE,
} from "../envelope-v2.ts";

/** Build a minimal valid v2-shape object for a given k byte. */
function makeV2Object(k: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: 2,
		k,
		id: new Uint8Array(16).fill(0xab),
		ts: 1000,
		from: "deadbeef".repeat(8),
		body: "hello",
		...overrides,
	};
}

describe("fromV2 — forward-compat unknown-kind sentinel", () => {
	it("returns sentinel for k=0x7F (unallocated byte)", () => {
		const v2 = makeV2Object(0x7f);
		// RED: should NOT throw — currently throws "unknown kind enum 0x7f"
		const result = fromV2(v2);
		expect(result.kind).toBe("chat-unknown-future");
		expect(result.raw).toBe(0x7f);
	});

	it("sentinel result still includes decoded id and ts fields", () => {
		const v2 = makeV2Object(0x7f);
		const result = fromV2(v2);
		expect(result.kind).toBe("chat-unknown-future");
		expect(result.raw).toBe(0x7f);
		// id should be decoded to UUID string
		expect(typeof result.id).toBe("string");
		expect((result.id as string).length).toBe(36);
		// ts should be absolute (delta + ROOM_EPOCH)
		expect(result.ts).toBe(1000 + ROOM_EPOCH);
	});

	it("returns sentinel for another unallocated byte k=0xFE", () => {
		const v2 = makeV2Object(0xfe);
		const result = fromV2(v2);
		expect(result.kind).toBe("chat-unknown-future");
		expect(result.raw).toBe(0xfe);
	});
});

describe("fromV2 / toV2 — known-kind round-trips", () => {
	it("chat-msg round-trips unchanged", () => {
		const id = "12345678-1234-1234-1234-123456789abc";
		const ts = ROOM_EPOCH + 5000;
		const original: Record<string, unknown> = {
			v: 1,
			id,
			ts,
			from: "peer1",
			kind: "chat-msg",
			body: "hi",
		};
		const v2 = toV2(original);
		const restored = fromV2(v2);
		expect(restored.kind).toBe("chat-msg");
		expect(restored.id).toBe(id);
		expect(restored.ts).toBe(ts);
		expect(restored.body).toBe("hi");
		expect(restored.v).toBe(1);
		expect(restored.raw).toBeUndefined();
	});

	it("chat-edit round-trips unchanged", () => {
		const id = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
		const ts = ROOM_EPOCH + 10000;
		const original: Record<string, unknown> = {
			v: 1,
			id,
			ts,
			from: "peer2",
			kind: "chat-edit",
			body: "edited text",
		};
		const v2 = toV2(original);
		const restored = fromV2(v2);
		expect(restored.kind).toBe("chat-edit");
		expect(restored.id).toBe(id);
		expect(restored.ts).toBe(ts);
		expect(restored.raw).toBeUndefined();
	});

	it("all known kinds in KIND_TO_BYTE round-trip without raw", () => {
		const id = "00000000-0000-0000-0000-000000000001";
		const ts = ROOM_EPOCH + 1;
		for (const kind of Object.keys(KIND_TO_BYTE)) {
			const original: Record<string, unknown> = { v: 1, id, ts, from: "x", kind };
			const v2 = toV2(original);
			const restored = fromV2(v2);
			expect(restored.kind).toBe(kind);
			expect(restored.raw).toBeUndefined();
		}
	});
});

describe("toV2 — send-side rejection of chat-unknown-future", () => {
	it("toV2 throws at runtime when given kind=chat-unknown-future", () => {
		const id = "12345678-1234-1234-1234-123456789abc";
		const ts = ROOM_EPOCH + 1;
		// Runtime guard: toV2 throws for kind not in KIND_TO_BYTE (incl. "chat-unknown-future")
		expect(() => toV2({ v: 1, id, ts, from: "x", kind: "chat-unknown-future" })).toThrow();
	});
});

describe("fromV2 — corrupt frame (non-numeric k) must throw", () => {
	it("throws with descriptive message when k is null", () => {
		const v2 = makeV2Object(0x01, { k: null });
		expect(() => fromV2(v2)).toThrow(/missing or non-numeric kind byte/);
	});

	it("throws with descriptive message when k is a string", () => {
		const v2 = makeV2Object(0x01, { k: "chat-msg" });
		expect(() => fromV2(v2)).toThrow(/missing or non-numeric kind byte/);
	});

	it("throws with descriptive message when k is missing (undefined)", () => {
		const v2 = makeV2Object(0x01, { k: undefined });
		expect(() => fromV2(v2)).toThrow(/missing or non-numeric kind byte/);
	});

	it("does NOT throw for a numeric unknown k — returns sentinel instead", () => {
		// Regression guard: ensure the throw path is narrow (non-numeric only).
		// Numeric unknown k is the forward-compat scenario; it must NOT throw.
		const v2 = makeV2Object(0x7f);
		expect(() => fromV2(v2)).not.toThrow();
		expect(fromV2(v2).kind).toBe("chat-unknown-future");
	});
});
