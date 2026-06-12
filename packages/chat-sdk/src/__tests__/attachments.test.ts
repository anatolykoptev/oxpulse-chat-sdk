/**
 * attachments.test.ts — W4: sendFile flow (v0.5.0).
 *
 * Verifies:
 *   - presignAttachment POSTs to /api/sdk/attachments/presign with correct fields
 *   - presignAttachment sends Authorization: Bearer header
 *   - sendFile calls presign then PUT then client.send in order
 *   - sendFile PUT uses the exact upload_url from presign
 *   - sendFile rejects blobs larger than MAX_ATTACHMENT_BYTES before network
 *   - MAX_ATTACHMENT_BYTES is exported and positive
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SDKChatClient } from "../client.js";
import { sendFile, presignAttachment, MAX_ATTACHMENT_BYTES } from "../attachments.js";
import { SDKChatError } from "../errors.js";

const BASE_URL = "https://chat.example.com";
const JWT = "test-jwt";
const ROOM_ID = "room-attach";
const SENDER_UID = "user-123";

function makeClient() {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
}

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (status >= 400 ? String(status) : ""),
    headers: { get: () => null } as unknown as Headers,
  } as unknown as Response;
}

describe("attachments (W4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── presignAttachment ──────────────────────────────────────────────────────

  it("presignAttachment POSTs presign request with correct fields", async () => {
    const presignResp = {
      attachment_id: "att-123",
      upload_url: "/api/sdk/attachments/att-123?t=token",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce(fakeResponse(presignResp));
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    const result = await presignAttachment(client, {
      mimeType: "image/png",
      byteSize: 1024,
      sha256: "deadbeef",
    });

    expect(result.attachmentId).toBe("att-123");
    expect(result.uploadUrl).toBe("/api/sdk/attachments/att-123?t=token");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/sdk/attachments/presign`);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body["mime_type"]).toBe("image/png");
    expect(body["byte_size"]).toBe(1024);
    expect(body["sha256"]).toBe("deadbeef");
  });

  it("presignAttachment sends Authorization: Bearer header", async () => {
    const presignResp = {
      attachment_id: "att-124",
      upload_url: "/api/sdk/attachments/att-124?t=token",
    };
    const mockFetch = vi.fn().mockResolvedValueOnce(fakeResponse(presignResp));
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    await presignAttachment(client, { mimeType: "text/plain", byteSize: 10, sha256: "aa" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string>;
    expect(headers?.["Authorization"] ?? headers?.["authorization"]).toBe(`Bearer ${JWT}`);
  });

  // ── sendFile ───────────────────────────────────────────────────────────────

  it("sendFile calls presign then PUT then client.send in order", async () => {
    const presignResp = {
      attachment_id: "att-999",
      upload_url: "/api/sdk/attachments/att-999?t=token",
    };
    const sendResp = { seq: 1, msg_id: "msg-001" };

    const callOrder: string[] = [];

    const mockFetch = vi
      .fn()
      // 1st call: presign
      .mockImplementationOnce(async (url: string) => {
        if (String(url).includes("presign")) {
          callOrder.push("presign");
          return fakeResponse(presignResp);
        }
        return fakeResponse(null, 500);
      })
      // 2nd call: PUT upload
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          callOrder.push("put");
          return fakeResponse(null, 204);
        }
        return fakeResponse(null, 500);
      })
      // 3rd call: POST /api/sdk/messages (client.send)
      .mockImplementationOnce(async () => {
        callOrder.push("send");
        return fakeResponse(sendResp);
      });

    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    const sealedPayload = new ArrayBuffer(8);
    const blob = new Blob(["hello"], { type: "image/png" });

    await sendFile(client, ROOM_ID, blob, {
      senderUid: SENDER_UID,
      sealed: sealedPayload,
      mimeType: "image/png",
      sha256: "cafebabe",
    });

    expect(callOrder).toEqual(["presign", "put", "send"]);
  });

  it("sendFile PUT uses the exact upload_url from presign response", async () => {
    const UPLOAD_PATH = "/api/sdk/attachments/att-456";
    const presignResp = {
      attachment_id: "att-456",
      upload_url: `${UPLOAD_PATH}?t=sig123`,
    };
    const sendResp = { seq: 2, msg_id: "msg-002" };

    const putUrls: string[] = [];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(presignResp))
      .mockImplementationOnce(async (url: string) => {
        putUrls.push(String(url));
        return fakeResponse(null, 204);
      })
      .mockResolvedValueOnce(fakeResponse(sendResp));

    vi.stubGlobal("fetch", mockFetch);
    const client = makeClient();
    const blob = new Blob(["data"], { type: "image/png" });
    await sendFile(client, ROOM_ID, blob, {
      senderUid: SENDER_UID,
      sealed: new ArrayBuffer(4),
      mimeType: "image/png",
      sha256: "sha",
    });

    expect(putUrls.length).toBe(1);
    expect(putUrls[0]).toContain(UPLOAD_PATH);
  });

  it("sendFile rejects blobs larger than MAX_ATTACHMENT_BYTES", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    // Simulate an oversized blob by object with size property.
    const oversized = { size: MAX_ATTACHMENT_BYTES + 1, type: "image/png" } as Blob;

    await expect(
      sendFile(client, ROOM_ID, oversized, {
        senderUid: SENDER_UID,
        sealed: new ArrayBuffer(4),
        mimeType: "image/png",
        sha256: "sha",
      }),
    ).rejects.toThrow(SDKChatError);

    // fetch must NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── MAX_ATTACHMENT_BYTES export ────────────────────────────────────────────

  it("MAX_ATTACHMENT_BYTES is exported and positive", () => {
    expect(typeof MAX_ATTACHMENT_BYTES).toBe("number");
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(0);
  });
});
