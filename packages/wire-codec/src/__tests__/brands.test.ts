import { describe, it, expect } from "vitest";
import { asWireBytes, asSealedBytes, encodeHttpBody, decodeHttpBody } from "../index.js";
import type { WireBytes, SealedBytes } from "../index.js";

// Type-level assertion: raw Uint8Array MUST NOT be assignable to WireBytes.
// The @ts-expect-error directive below is the compile-time gate.
// If this directive becomes a NO-OP (tsc no longer sees an error), the
// brand has been weakened and the test file will fail to typecheck.
//
// Wrapped in a never-called function so vitest doesn't execute the call
// at module load (a raw 0x7B byte routes to JSON.parse which would throw).
function _typeAssertions(): void {
  // @ts-expect-error — raw Uint8Array cannot be passed where WireBytes is required
  decodeHttpBody(new Uint8Array([0x7b]));

  // Also verify SealedBytes is a distinct brand from WireBytes:
  // @ts-expect-error — SealedBytes cannot be passed where WireBytes is required
  const _wb: WireBytes = new Uint8Array([0]) as SealedBytes;
  void _wb;
}
void _typeAssertions; // suppress "unused" warnings

describe("brands", () => {
  it("asWireBytes lifts raw bytes — runtime is identical to Uint8Array", () => {
    const raw = new Uint8Array([0x7b, 0x7d]);
    const lifted = asWireBytes(raw);
    expect(lifted instanceof Uint8Array).toBe(true);
    expect(lifted.length).toBe(2);
    expect(lifted[0]).toBe(0x7b);
    expect(lifted[1]).toBe(0x7d);
  });

  it("asSealedBytes lifts raw bytes — runtime is identical to Uint8Array", () => {
    const raw = new Uint8Array([0x01, 0x02, 0x03]);
    const lifted = asSealedBytes(raw);
    expect(lifted instanceof Uint8Array).toBe(true);
    expect(lifted.length).toBe(3);
  });

  it("asWireBytes returns the same object reference (no copy)", () => {
    const raw = new Uint8Array([0xc6]);
    const lifted = asWireBytes(raw);
    // Brand is phantom — same backing buffer, no allocation.
    expect(lifted.buffer).toBe(raw.buffer);
  });

  it("encodeHttpBody return type is WireBytes — compile-time-only check", () => {
    // Never-called helper proves the return type at compile time.
    // tsc will error if encodeHttpBody doesn't return WireBytes.
    function _compileCheck(): void {
      const out = encodeHttpBody(new Uint8Array([0x7b, 0x7d]));
      const _typed: WireBytes = out;
      void _typed;
    }
    void _compileCheck;
    // Runtime: verify asWireBytes is a zero-cost identity.
    const raw = new Uint8Array([0x7b, 0x7d]);
    const wb = asWireBytes(raw);
    expect(wb.length).toBe(2);
  });
});
