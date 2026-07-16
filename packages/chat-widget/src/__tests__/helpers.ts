/**
 * helpers.ts — shared vitest mocks for the chat-widget unit tests.
 *
 * Extracted from attachment-picker.test.ts / composer.test.ts, which had
 * hand-duplicated `makeStubClient` stubs under the same name. The two copies
 * had drifted: the attachment-picker variant returned an upload surface
 * (uploadAttachment / sendAttachmentMessage with resolveWith / rejectWith /
 * delayMs), while the composer variant returned a text-send surface
 * (list / subscribe / sendText / sendTextOptimistic with sendTextResolve /
 * sendTextReject / hasE2ee / sendTextOptimisticResolve). This helper unifies
 * on the superset — every option field and return method either copy relied on
 * is preserved.
 *
 * Reconciliation: the Composer gates the paperclip / mic buttons on
 * `typeof client.uploadAttachment === 'function'`, so the attachment methods
 * must be OPT-IN via `withAttachments: true` — the composer copy never
 * included them (it adds them via makeAttachmentStubs() or explicit vars),
 * and `mic_button_hidden_without_attachment_capability` relies on their
 * absence. attachment-picker.test.ts uses a thin local wrapper that defaults
 * `withAttachments: true` so its 31 call sites need no changes.
 *
 * The attachment-picker copy's private `makeStubAttachment` builder (only ever
 * called from inside its `makeStubClient`) is inlined here so the extraction
 * does not introduce a second shared helper.
 *
 * Keep test-only; not exported from the package index.
 */

import { vi } from 'vitest';
import type { EnvelopeAttachment } from '../utils/attachment-envelope.js';

export interface StubClient {
  list: (roomId: string, args: { limit: number }) => Promise<{ items: unknown[]; hasNext: boolean }>;
  subscribe: (roomId: string, args: unknown) => () => void;
  sendText: ReturnType<typeof vi.fn>;
  sendTextOptimistic?: ReturnType<typeof vi.fn>;
  e2ee?: boolean;
}

export interface StubClientWithAttachments extends StubClient {
  uploadAttachment: ReturnType<typeof vi.fn>;
  sendAttachmentMessage: ReturnType<typeof vi.fn>;
}

export interface MakeStubClientOpts {
  // ── attachment-upload options (attachment-picker copy) ──
  resolveWith?: { attachmentId: string; attachment: EnvelopeAttachment };
  rejectWith?: Error;
  delayMs?: number;
  // ── text-send options (composer copy) ──
  sendTextResolve?: { msgId: string };
  sendTextReject?: Error;
  hasE2ee?: boolean;
  sendTextOptimisticResolve?: { msgId: string };
  // ── reconciliation flag ──
  withAttachments?: boolean;
}

/** Unified stub SDK client — overload: withAttachments=true includes upload surface. */
export function makeStubClient(
  opts: MakeStubClientOpts & { withAttachments: true },
): StubClientWithAttachments;
/** Unified stub SDK client — overload: default (no attachment methods). */
export function makeStubClient(
  opts?: MakeStubClientOpts & { withAttachments?: false },
): StubClient;
/** Implementation — do not call directly; use the overloads above. */
export function makeStubClient(opts: MakeStubClientOpts = {}): StubClient | StubClientWithAttachments {
  const base: StubClient = {
    // ── text-send surface (composer copy) ──
    list: (_roomId: string, _args: { limit: number }) =>
      Promise.resolve({ items: [], hasNext: false }),
    subscribe: (_roomId: string, _args: unknown) => () => {},
    sendText: vi.fn(() =>
      opts.sendTextReject
        ? Promise.reject(opts.sendTextReject)
        : Promise.resolve(opts.sendTextResolve ?? { msgId: 'msg1' }),
    ),
    ...(opts.hasE2ee
      ? {
          sendTextOptimistic: vi.fn(() =>
            Promise.resolve(opts.sendTextOptimisticResolve ?? { msgId: 'opt1' }),
          ),
          e2ee: true,
        }
      : {}),
  };

  if (!opts.withAttachments) {
    return base;
  }

  // ── attachment-upload surface (attachment-picker copy) ──
  return {
    ...base,
    uploadAttachment: vi.fn((_roomId: string, blob: Blob, args: unknown) => {
      const a = args as {
        mimeType?: string;
        filename?: string;
        width?: number;
        height?: number;
      };
      const attachmentId = opts.resolveWith?.attachmentId ?? 'att-1';
      const result = opts.resolveWith ?? {
        attachmentId,
        attachment: {
          id: attachmentId,
          mime: a.mimeType ?? blob.type,
          filename: a.filename ?? 'file',
          sizeBytes: blob.size,
          width: a.width,
          height: a.height,
        } as EnvelopeAttachment,
      };
      if (opts.delayMs) {
        return new Promise<typeof result>((resolve, reject) => {
          setTimeout(() => {
            if (opts.rejectWith) reject(opts.rejectWith);
            else resolve(result);
          }, opts.delayMs);
        });
      }
      if (opts.rejectWith) return Promise.reject(opts.rejectWith);
      return Promise.resolve(result);
    }),
    sendAttachmentMessage: vi.fn(),
  };
}
