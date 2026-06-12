// Pure unit tests for the thumbhash wrapper. The browser-side
// canvas → RGBA path is tested integrationally inside AttachmentSlot;
// here we pin only the wrapper guarantees: roundtrip, error shape,
// and data-URL output format.

import { describe, it, expect } from "vitest";
import {
	coerceThumbHash,
	decodeThumbHash,
	encodeThumbHash,
	THUMBHASH_MAX_SIDE,
	thumbHashToImageUrl,
	thumbHashWireToImageUrl,
} from "../thumbhash";

function makeSolidColorRgba(
	width: number,
	height: number,
	r: number,
	g: number,
	b: number,
): Uint8Array {
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = r;
		rgba[i + 1] = g;
		rgba[i + 2] = b;
		rgba[i + 3] = 255;
	}
	return rgba;
}

describe("encodeThumbHash", () => {
	it("encodes a 64x64 solid-red image to a small (<40 B) hash", () => {
		const rgba = makeSolidColorRgba(64, 64, 255, 0, 0);
		const hash = encodeThumbHash({ width: 64, height: 64, rgba });
		expect(hash).toBeInstanceOf(Uint8Array);
		expect(hash.length).toBeGreaterThan(15);
		expect(hash.length).toBeLessThan(40);
	});

	it("encodes a 100x100 image at the documented max side", () => {
		const rgba = makeSolidColorRgba(100, 100, 0, 200, 0);
		const hash = encodeThumbHash({ width: 100, height: 100, rgba });
		expect(hash.length).toBeLessThan(40);
	});

	it("throws on zero/negative dimensions", () => {
		expect(() =>
			encodeThumbHash({ width: 0, height: 50, rgba: new Uint8Array(0) }),
		).toThrow(/invalid dimensions/);
		expect(() =>
			encodeThumbHash({ width: 50, height: -1, rgba: new Uint8Array(0) }),
		).toThrow(/invalid dimensions/);
	});

	it("throws when dims exceed THUMBHASH_MAX_SIDE", () => {
		const tooBig = THUMBHASH_MAX_SIDE + 1;
		const rgba = makeSolidColorRgba(tooBig, 50, 10, 10, 10);
		expect(() =>
			encodeThumbHash({ width: tooBig, height: 50, rgba }),
		).toThrow(/exceed thumbhash max/);
	});

	it("throws when rgba length does not match w*h*4", () => {
		expect(() =>
			encodeThumbHash({ width: 10, height: 10, rgba: new Uint8Array(40) }),
		).toThrow(/rgba length/);
	});
});

describe("decodeThumbHash", () => {
	it("roundtrip: reddish input → reddish dominant decoded pixel", () => {
		const rgba = makeSolidColorRgba(80, 80, 200, 50, 50);
		const hash = encodeThumbHash({ width: 80, height: 80, rgba });
		const decoded = decodeThumbHash(hash);
		expect(decoded.width).toBeGreaterThan(0);
		expect(decoded.height).toBeGreaterThan(0);
		expect(decoded.rgba.length).toBe(decoded.width * decoded.height * 4);
		// Sample a center-ish pixel: should be red-dominant (R > G, R > B).
		const centerIdx =
			(Math.floor(decoded.height / 2) * decoded.width +
				Math.floor(decoded.width / 2)) *
			4;
		expect(decoded.rgba[centerIdx]).toBeGreaterThan(decoded.rgba[centerIdx + 1]!);
		expect(decoded.rgba[centerIdx]).toBeGreaterThan(decoded.rgba[centerIdx + 2]!);
	});
});

describe("thumbHashToImageUrl", () => {
	it("returns a valid PNG data URL", () => {
		const rgba = makeSolidColorRgba(50, 50, 0, 128, 255);
		const hash = encodeThumbHash({ width: 50, height: 50, rgba });
		const url = thumbHashToImageUrl(hash);
		expect(url).toMatch(/^data:image\/png;base64,/);
		expect(url.length).toBeGreaterThan(100);
	});
});

describe("coerceThumbHash", () => {
	it("returns null for undefined", () => {
		expect(coerceThumbHash(undefined)).toBeNull();
	});

	it("returns null for empty Uint8Array", () => {
		expect(coerceThumbHash(new Uint8Array(0))).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(coerceThumbHash("")).toBeNull();
	});

	it("passes Uint8Array through unchanged", () => {
		const u = new Uint8Array([1, 2, 3]);
		expect(coerceThumbHash(u)).toBe(u);
	});

	it("decodes base64 string to bytes", () => {
		// "hello" → "aGVsbG8="
		const decoded = coerceThumbHash("aGVsbG8=");
		expect(decoded).toBeInstanceOf(Uint8Array);
		expect(Array.from(decoded!)).toEqual([104, 101, 108, 108, 111]);
	});

	it("returns null for invalid base64", () => {
		expect(coerceThumbHash("not!valid!base64!!!")).toBeNull();
	});
});

describe("thumbHashWireToImageUrl", () => {
	it("renders Uint8Array hash to a PNG data URL", () => {
		const rgba = makeSolidColorRgba(60, 60, 30, 200, 30);
		const hash = encodeThumbHash({ width: 60, height: 60, rgba });
		const url = thumbHashWireToImageUrl(hash);
		expect(url).toMatch(/^data:image\/png;base64,/);
	});

	it("renders base64-string hash to a PNG data URL", () => {
		const rgba = makeSolidColorRgba(60, 60, 30, 30, 200);
		const hash = encodeThumbHash({ width: 60, height: 60, rgba });
		// Base64-encode the bytes (mimics JSON wire form).
		let bin = "";
		for (const byte of hash) bin += String.fromCharCode(byte);
		const b64 = btoa(bin);
		const url = thumbHashWireToImageUrl(b64);
		expect(url).toMatch(/^data:image\/png;base64,/);
	});

	it("returns null for undefined / empty / invalid input", () => {
		expect(thumbHashWireToImageUrl(undefined)).toBeNull();
		expect(thumbHashWireToImageUrl("")).toBeNull();
		expect(thumbHashWireToImageUrl(new Uint8Array(0))).toBeNull();
	});
});
