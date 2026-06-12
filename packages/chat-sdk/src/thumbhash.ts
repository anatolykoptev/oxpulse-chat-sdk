// thumb-hash.ts — compact preview encoding for image attachments.
//
// Uses thumbhash (https://evanw.github.io/thumbhash/): ~25-32 bytes
// per image, decodes to a blurry ~32x32 color preview placeholder.
// 10–50x smaller than equivalent base64 JPEG/WebP data URLs.
//
// IMPORTANT: thumbhash requires input dimensions ≤ 100px on both
// axes. Callers must downscale (typically to a 64x64 / 100x100
// canvas) before invoking encodeThumbHash.

import { rgbaToThumbHash, thumbHashToRGBA, thumbHashToDataURL } from "thumbhash";

export interface ThumbHashEncodeInput {
	readonly width: number;
	readonly height: number;
	/** RGBA pixels, 4 bytes per pixel, row-major. */
	readonly rgba: Uint8Array;
}

/** Maximum side length thumbhash will accept (per its README). */
export const THUMBHASH_MAX_SIDE = 100;

/** Encode RGBA pixel data to a compact ThumbHash. Throws if dims
 *  invalid or exceed THUMBHASH_MAX_SIDE. */
export function encodeThumbHash(input: ThumbHashEncodeInput): Uint8Array {
	const { width, height, rgba } = input;
	if (width <= 0 || height <= 0) {
		throw new Error("encodeThumbHash: invalid dimensions");
	}
	if (width > THUMBHASH_MAX_SIDE || height > THUMBHASH_MAX_SIDE) {
		throw new Error(
			`encodeThumbHash: dims ${width}x${height} exceed thumbhash max ${THUMBHASH_MAX_SIDE}px`,
		);
	}
	if (rgba.length !== width * height * 4) {
		throw new Error(
			`encodeThumbHash: rgba length ${rgba.length} != ${width}*${height}*4`,
		);
	}
	return new Uint8Array(rgbaToThumbHash(width, height, rgba));
}

/** Decode a ThumbHash back to RGBA pixels. */
export function decodeThumbHash(
	hash: Uint8Array,
): { readonly width: number; readonly height: number; readonly rgba: Uint8Array } {
	const result = thumbHashToRGBA(hash);
	return {
		width: result.w,
		height: result.h,
		rgba: new Uint8Array(result.rgba),
	};
}

/** Decode ThumbHash directly to a PNG data URL — convenient for
 *  <img src="…"> placeholders in the browser. */
export function thumbHashToImageUrl(hash: Uint8Array): string {
	return thumbHashToDataURL(hash);
}

/** Coerce a wire-form thumbHash to Uint8Array. Schema accepts both
 *  Uint8Array (CBOR-native, Phase 2.B) and base64-string (JSON
 *  fallback). Returns null if input is empty or undecodable. */
export function coerceThumbHash(
	input: Uint8Array | string | undefined,
): Uint8Array | null {
	if (input === undefined) return null;
	if (input instanceof Uint8Array) return input.length > 0 ? input : null;
	if (typeof input === "string") {
		if (input.length === 0) return null;
		try {
			// atob path: standard base64 (no data: URL prefix expected).
			const bin = atob(input);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out.length > 0 ? out : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** One-shot helper: take a wire-form thumbHash (Uint8Array | base64
 *  string | undefined) and return a renderable PNG data URL, or null
 *  if it cannot be decoded. */
export function thumbHashWireToImageUrl(
	input: Uint8Array | string | undefined,
): string | null {
	const bytes = coerceThumbHash(input);
	if (!bytes) return null;
	try {
		return thumbHashToImageUrl(bytes);
	} catch {
		return null;
	}
}
