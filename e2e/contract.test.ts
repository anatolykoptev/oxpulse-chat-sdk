/**
 * @module e2e.contract
 *
 * Env-gated wire-contract test against a live oxpulse-chat staging server.
 *
 * Auth path: demo app self-mint (POST /api/sdk/demo/mint-token) — unauthenticated,
 * env-gated on server side (OXPULSE_CHAT_DEMO_TOKEN_KEY). Issues an ephemeral
 * anon_* JWT scoped to a per-product demo room. Zero operator provisioning required
 * when staging has the demo key configured; the test mints its own token at runtime.
 *
 * Env vars:
 *   CHAT_SDK_CONTRACT_BASE_URL — required gate (e.g. http://127.0.0.1:8917)
 *
 * Skip: all tests skip when CHAT_SDK_CONTRACT_BASE_URL is unset, so the file
 * is always safe to commit and run in CI without a live server.
 *
 * NOTE on send: the staging DB may not have the demo_marketplace app seeded
 * (FK constraint on sdk_apps table). We assert on list/subscribe-ticket only,
 * not on append, since the envelope contract does not require pre-seeded rows.
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.CHAT_SDK_CONTRACT_BASE_URL ?? "";
const ENABLED = BASE_URL.length > 0;

// ---------------------------------------------------------------------------
// Token mint helper — demo self-mint, no pre-shared secret required.
// ---------------------------------------------------------------------------

interface DemoMintResponse {
  token: string;
  expires_at: number;
  user_id: string;
  room_id: string;
}

async function mintDemoToken(base: string): Promise<DemoMintResponse> {
  // Use a fixed UUID so the per-product room_id is deterministic and stable
  // across test runs (no orphan rooms accumulate).
  const sessionId = "10000000-0000-4000-8000-000000000e2e";
  const productId = "product-1";
  const resp = await fetch(`${base}/api/sdk/demo/mint-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, product_id: productId }),
  });
  if (!resp.ok) {
    throw new Error(
      `demo/mint-token failed: HTTP ${resp.status} ${await resp.text()}`
    );
  }
  return resp.json() as Promise<DemoMintResponse>;
}

// ---------------------------------------------------------------------------
// Test state — minted once for the whole suite.
// ---------------------------------------------------------------------------

let jwt = "";
let roomId = "";

describe.skipIf(!ENABLED)("wire-contract: list + subscribe-ticket", () => {
  beforeAll(async () => {
    const minted = await mintDemoToken(BASE_URL);
    jwt = minted.token;
    roomId = minted.room_id;
  });

  // ── 1. GET /api/sdk/messages ────────────────────────────────────────────

  it("GET messages returns 200 with correct envelope shape", async () => {
    const params = new URLSearchParams({
      room_id: roomId,
      after_seq: "0",
      limit: "10",
    });
    const resp = await fetch(`${BASE_URL}/api/sdk/messages?${params}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as Record<string, unknown>;

    // Envelope-level wire-contract assertions:
    // - crypto_mode must be present (Phase 2 field).
    expect(body).toHaveProperty("crypto_mode");
    expect(typeof body.crypto_mode).toBe("string");

    // - items must be an array (may be empty for a fresh demo room).
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);

    // - has_more is the pagination sentinel.
    expect(body).toHaveProperty("has_more");
  });

  it("GET messages envelope crypto_mode is a known value", async () => {
    const params = new URLSearchParams({
      room_id: roomId,
      after_seq: "0",
      limit: "1",
    });
    const resp = await fetch(`${BASE_URL}/api/sdk/messages?${params}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = (await resp.json()) as { crypto_mode: string };
    expect(["sframe-static", "plaintext"]).toContain(body.crypto_mode);
  });

  it(
    "GET messages items each have msg_id and seq fields when items are present",
    async () => {
      const params = new URLSearchParams({
        room_id: roomId,
        after_seq: "0",
        limit: "10",
      });
      const resp = await fetch(`${BASE_URL}/api/sdk/messages?${params}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        items: Array<Record<string, unknown>>;
      };

      // Wire-contract: each item in the array must have msg_id (string) and seq (number).
      // The list may be empty for a fresh demo room — that is valid.
      for (const item of body.items) {
        expect(item).toHaveProperty("msg_id");
        expect(typeof item.msg_id).toBe("string");
        expect(item).toHaveProperty("seq");
        expect(typeof item.seq).toBe("number");
      }
    }
  );

  // ── 2. POST /api/sdk/messages/subscribe-ticket ─────────────────────────

  it("POST subscribe-ticket returns 200 with ticket string", async () => {
    const resp = await fetch(
      `${BASE_URL}/api/sdk/messages/subscribe-ticket`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ room_id: roomId, after_seq: 0 }),
      }
    );
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as Record<string, unknown>;

    // Wire-contract: subscribe-ticket response must have a ticket string.
    // (The SSE stream is opened by the client appending ?ticket=<value>.)
    expect(body).toHaveProperty("ticket");
    expect(typeof body.ticket).toBe("string");
    expect((body.ticket as string).length).toBeGreaterThan(0);
  });
});
