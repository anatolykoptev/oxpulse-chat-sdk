/**
 * composer.test.ts — TDD RED phase.
 *
 * Tests: Composer class (W2.2 slice 2 acceptance criteria + slice 4 attachment additions).
 * Stub client mirrors element.ts stub pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Composer } from '../ui/composer.js';
import { MAX_BODY_CHARS } from '../utils/textfield-helpers.js';
import { createVoiceRecorder, type VoiceRecorder } from '../utils/voice.js';

vi.mock('../utils/voice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/voice.js')>();
  return {
    ...actual,
    createVoiceRecorder: vi.fn(),
  };
});

// ── Stub client ────────────────────────────────────────────────────────────────

function makeStubClient(opts: {
  sendTextResolve?: { msgId: string };
  sendTextReject?: Error;
  hasE2ee?: boolean;
  sendTextOptimisticResolve?: { msgId: string };
}) {
  return {
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
}

/**
 * Slice 4/5: stage-then-send attachment stubs. uploadAttachment resolves
 * eagerly (UPLOAD-ON-STAGE) independent of any explicit send; sendAttachmentMessage
 * is the separate call the Composer fires only when the user hits send.
 */
function makeAttachmentStubs(opts: {
  uploadResolve?: { attachmentId: string; attachment: { id: string; mime: string; filename: string; sizeBytes: number; width?: number; height?: number } };
  uploadReject?: Error;
  sendResolve?: { msgId: string };
  sendReject?: Error;
} = {}) {
  return {
    uploadAttachment: vi.fn(() =>
      opts.uploadReject
        ? Promise.reject(opts.uploadReject)
        : Promise.resolve(
            opts.uploadResolve ?? {
              attachmentId: 'att-1',
              attachment: { id: 'att-1', mime: 'image/png', filename: 'photo.png', sizeBytes: 100 },
            },
          ),
    ),
    sendAttachmentMessage: vi.fn(() =>
      opts.sendReject
        ? Promise.reject(opts.sendReject)
        : Promise.resolve(opts.sendResolve ?? { msgId: 'msg-att' }),
    ),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// B1: helpers query the observable DOM container, NOT internal private fields

function getInput(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('.oxp-composer-input') as HTMLTextAreaElement | null;
  if (!el) throw new Error('textarea not found');
  return el;
}

function getSendBtn(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('.oxp-composer-send') as HTMLButtonElement | null;
  if (!el) throw new Error('send button not found');
  return el;
}

function getCounter(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.oxp-composer-counter') as HTMLElement | null;
  if (!el) throw new Error('counter not found');
  return el;
}

// Helper: fire an input event to trigger internal state update
function setInputValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
}

// Helper: drain microtasks
async function drain(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * Compression wiring (issue #67): AttachmentPicker.#upload() now runs the real
 * compress() for every image/* file before calling client.sendFile — jsdom
 * implements none of createImageBitmap/canvas/FileReader natively, so any
 * test that pastes/drops a real image File through the REAL Composer ->
 * AttachmentPicker chain needs this stub (matches the pattern already proven
 * in attachment-picker.test.ts). FakeReader resolves via microtask (not
 * setTimeout) so this file's `drain()` (a bounded Promise.resolve() loop)
 * actually flushes it.
 */
function stubImageCompression(): void {
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() }));
  const mockCtx = { imageSmoothingEnabled: false, imageSmoothingQuality: 'high', drawImage: vi.fn() };
  const compressedBlob = new Blob(['compressed'], { type: 'image/webp' });
  const mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn().mockReturnValue(mockCtx),
    toBlob: vi.fn().mockImplementation((cb: (b: Blob | null) => void) => cb(compressedBlob)),
  };
  const origCreate = globalThis.document.createElement.bind(globalThis.document);
  vi.spyOn(globalThis.document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return mockCanvas as unknown as HTMLElement;
    return origCreate(tag);
  });
  class FakeReader {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    result = 'data:image/webp;base64,AA==';
    readAsDataURL() { void Promise.resolve().then(() => this.onload?.()); }
  }
  vi.stubGlobal('FileReader', FakeReader);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Composer', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    stubImageCompression();
    vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: { getUserMedia: vi.fn() } });
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders_textarea_and_send_button', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = container.querySelector('.oxp-composer-input');
    const button = container.querySelector('.oxp-composer-send');
    expect(textarea).not.toBeNull();
    expect(button).not.toBeNull();

    composer.destroy();
  });

  it('cmd_enter_sends_message', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'hello world');

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await drain(10);

    expect(client.sendText).toHaveBeenCalledOnce();
    expect(client.sendText).toHaveBeenCalledWith('r1', 'hello world', expect.anything());

    composer.destroy();
  });

  it('plain_enter_inserts_newline', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    textarea.value = 'line1';

    // plain Enter — default textarea behavior; we just check sendText NOT called
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await drain();

    expect(client.sendText).not.toHaveBeenCalled();

    composer.destroy();
  });

  it('whitespace_only_disables_send', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const btn = getSendBtn(container);

    // Initially empty → disabled
    expect(btn.disabled).toBe(true);

    // Whitespace only
    setInputValue(textarea, '   \n  ');
    expect(btn.disabled).toBe(true);

    // Real text → enabled
    setInputValue(textarea, 'hi');
    expect(btn.disabled).toBe(false);

    composer.destroy();
  });

  it('clears_input_after_successful_send', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'test message');

    getSendBtn(container).click();
    await drain(20);

    expect(textarea.value).toBe('');

    composer.destroy();
  });

  it('dispatches_error_event_on_send_failure', async () => {
    const client = makeStubClient({ sendTextReject: new Error('network fail') });
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'test');

    const errorPromise = new Promise<CustomEvent>((resolve) => {
      container.addEventListener('oxpulse-chat:error', (ev) => resolve(ev as CustomEvent));
    });

    getSendBtn(container).click();
    const evt = await errorPromise;
    expect(evt.detail).toMatchObject({ kind: 'send_failed' });

    composer.destroy();
  });

  it('char_counter_hidden_below_threshold', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const counter = getCounter(container);

    // 0% — hidden
    expect(counter.hidden).toBe(true);

    // 50%
    setInputValue(textarea, 'x'.repeat(Math.floor(MAX_BODY_CHARS * 0.5)));
    expect(counter.hidden).toBe(true);

    // 89%
    setInputValue(textarea, 'x'.repeat(Math.floor(MAX_BODY_CHARS * 0.89)));
    expect(counter.hidden).toBe(true);

    composer.destroy();
  });

  it('char_counter_visible_at_90_percent', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const counter = getCounter(container);

    const threshold = Math.floor(MAX_BODY_CHARS * 0.9) + 1;
    setInputValue(textarea, 'x'.repeat(threshold));

    expect(counter.hidden).toBe(false);
    // Counter text should mention remaining chars
    const remaining = MAX_BODY_CHARS - threshold;
    expect(counter.textContent).toContain(String(remaining));

    composer.destroy();
  });

  it('over_limit_disables_send', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const btn = getSendBtn(container);

    setInputValue(textarea, 'x'.repeat(MAX_BODY_CHARS + 1));
    expect(btn.disabled).toBe(true);

    composer.destroy();
  });

  it('prefers_optimistic_send_when_e2ee_configured', async () => {
    const client = makeStubClient({ hasE2ee: true });
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'encrypted');

    getSendBtn(container).click();
    await drain(10);

    expect((client as ReturnType<typeof makeStubClient> & { sendTextOptimistic: ReturnType<typeof vi.fn> }).sendTextOptimistic).toHaveBeenCalledOnce();
    expect(client.sendText).not.toHaveBeenCalled();

    composer.destroy();
  });

  it('falls_back_to_sendText_when_no_e2ee', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'plain');

    getSendBtn(container).click();
    await drain(10);

    expect(client.sendText).toHaveBeenCalledOnce();

    composer.destroy();
  });

  it('abort_during_send_does_not_clear_input', async () => {
    // Slow send — never resolves during test
    let resolveSend!: () => void;
    const client = {
      list: (_roomId: string, _args: { limit: number }) => Promise.resolve({ items: [], hasNext: false }),
      subscribe: () => () => {},
      sendText: vi.fn(() => new Promise<{ msgId: string }>((resolve) => { resolveSend = () => resolve({ msgId: 'x' }); })),
    };

    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'in-flight');

    getSendBtn(container).click();
    // Abort before send resolves
    composer.destroy();

    // Resolve the pending send (should be ignored)
    resolveSend();
    await drain(10);

    // Input NOT cleared (composer already destroyed, no state mutation)
    expect(textarea.value).toBe('in-flight');
  });

  it('aria_labels_present', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const btn = getSendBtn(container);
    const counter = getCounter(container);

    expect(textarea.getAttribute('aria-label')).toBe('Message input');
    expect(btn.getAttribute('aria-label')).toBe('Send message');
    expect(counter.getAttribute('aria-live')).toBe('polite');

    composer.destroy();
  });

  // ── B1: Fake-private trap must not be publicly accessible ──────────────────

  it('container_field_not_publicly_accessible', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    // True ECMAScript private #container must not be accessible via string key
    expect((composer as unknown as Record<string, unknown>)['#container']).toBeUndefined();
    composer.destroy();
  });

  // ── B2: Inline error chip on send failure ──────────────────────────────────

  it('renders_inline_error_chip_on_send_failure', async () => {
    const client = makeStubClient({ sendTextReject: new Error('network fail') });
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'test');

    getSendBtn(container).click();
    await drain(20);

    const errorChip = container.querySelector('.oxp-composer-error');
    expect(errorChip).not.toBeNull();
    expect(errorChip!.getAttribute('role')).toBe('alert');
    expect(errorChip!.getAttribute('aria-live')).toBe('assertive');
    expect(errorChip!.textContent).toContain('network fail');

    composer.destroy();
  });

  it('retry_button_replays_last_send', async () => {
    let callCount = 0;
    const client = {
      list: (_roomId: string, _args: { limit: number }) => Promise.resolve({ items: [], hasNext: false }),
      subscribe: () => () => {},
      sendText: vi.fn(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('temporary'));
        return Promise.resolve({ msgId: 'msg2' });
      }),
    };

    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'retry me');
    getSendBtn(container).click();
    await drain(20);

    // Error chip should be visible
    const errorChip = container.querySelector('.oxp-composer-error');
    expect(errorChip).not.toBeNull();

    // Click retry
    const retryBtn = errorChip!.querySelector('button');
    expect(retryBtn).not.toBeNull();
    retryBtn!.click();
    await drain(20);

    // Second call should succeed — error chip should be gone
    expect(client.sendText).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.oxp-composer-error')).toBeNull();

    composer.destroy();
  });

  // ── M1: e2ee=false must not trigger optimistic path ───────────────────────

  it('does_not_use_optimistic_when_e2ee_is_false', async () => {
    const client = {
      list: (_roomId: string, _args: { limit: number }) => Promise.resolve({ items: [], hasNext: false }),
      subscribe: () => () => {},
      sendText: vi.fn(() => Promise.resolve({ msgId: 'msg1' })),
      sendTextOptimistic: vi.fn(() => Promise.resolve({ msgId: 'opt1' })),
      e2ee: false,
    };

    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'plain message');
    getSendBtn(container).click();
    await drain(10);

    expect(client.sendTextOptimistic).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledOnce();

    composer.destroy();
  });

  // ── M2: Counter display clamps at 0 (no negatives) ───────────────────────

  it('counter_clamps_display_at_zero_when_over_limit', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const counter = getCounter(container);

    // Paste well beyond limit
    setInputValue(textarea, 'x'.repeat(MAX_BODY_CHARS + 100));
    expect(counter.hidden).toBe(false);
    // textContent should NOT be negative
    const text = counter.textContent ?? '';
    const num = parseInt(text.replace(/\D/g, ''), 10);
    expect(num).toBeGreaterThanOrEqual(0);

    composer.destroy();
  });

  // ── M3: AbortSignal early check + once ────────────────────────────────────

  it('mount_returns_early_when_signal_already_aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container, signal: ac.signal });
    composer.mount();

    // No root should be appended when signal was pre-aborted
    expect(container.querySelector('.oxp-composer')).toBeNull();
  });

  // ── M5: Placeholder text on textarea ─────────────────────────────────────

  it('textarea_has_default_placeholder', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    expect(textarea.placeholder).toBeTruthy();

    composer.destroy();
  });

  it('textarea_uses_custom_placeholder_option', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container, placeholder: 'Write something…' });
    composer.mount();

    const textarea = getInput(container);
    expect(textarea.placeholder).toBe('Write something…');

    composer.destroy();
  });

  // i18n follow-up: lang defaults to English (unchanged from before); lang='ru'
  // localizes the default placeholder unless an explicit `placeholder` override wins.
  it('textarea_default_placeholder_is_english_by_default', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    expect(getInput(container).placeholder).toBe('Type a message…');
    composer.destroy();
  });

  it('textarea_default_placeholder_is_russian_for_lang_ru', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container, lang: 'ru' });
    composer.mount();

    expect(getInput(container).placeholder).toBe('Введите сообщение…');
    composer.destroy();
  });

  it('explicit placeholder option wins over the localized default even with lang=ru', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container, lang: 'ru', placeholder: 'Write something…' });
    composer.mount();

    expect(getInput(container).placeholder).toBe('Write something…');
    composer.destroy();
  });

  it('localizes aria-labels and the Send button text for lang=ru', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container, lang: 'ru' });
    composer.mount();

    const textarea = getInput(container);
    const sendBtn = container.querySelector('.oxp-composer-send') as HTMLButtonElement;
    expect(textarea.getAttribute('aria-label')).toBe('Поле ввода сообщения');
    expect(sendBtn.getAttribute('aria-label')).toBe('Отправить сообщение');
    expect(sendBtn.querySelector('svg')).not.toBeNull();

    composer.destroy();
  });

  // ── M7: IME composition guard ──────────────────────────────────────────────

  it('ignores_cmd_enter_during_ime_composition', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'composing');

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true, bubbles: true }),
    );
    await drain(10);

    // sendText must NOT be called during composition
    expect(client.sendText).not.toHaveBeenCalled();

    composer.destroy();
  });

  // ── M8: Autogrow height wired ──────────────────────────────────────────────

  it('autogrows_height_on_multiline_input', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    // Simulate a scrollHeight larger than a single row
    Object.defineProperty(textarea, 'scrollHeight', { get: () => 80, configurable: true });
    setInputValue(textarea, 'line1\nline2\nline3');

    expect(textarea.style.height).not.toBe('');

    composer.destroy();
  });

  // ── Slice 4: Attachment integration ─────────────────────────────────────────

  it('paperclip_button_opens_file_dialog', () => {
    // uploadAttachment + sendAttachmentMessage must both be present for paperclip to render
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const btn = container.querySelector('.oxp-composer-attachment-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Attach files');

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    btn!.click();
    expect(clickSpy).toHaveBeenCalled();

    composer.destroy();
  });

  // BUG-1 (spec 2026-07-14): AttachmentPicker used to render its OWN visible
  // 📎 button above the reply block, duplicating composer.ts's trigger.
  it('bug1_renders_exactly_one_paperclip_trigger_no_picker_owned_button', () => {
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const paperclipButtons = container.querySelectorAll('.oxp-composer-attachment-btn');
    expect(paperclipButtons.length).toBe(1);
    // The trigger is an SVG image icon (not the old 📎 emoji text).
    expect(paperclipButtons[0].querySelector('svg')).not.toBeNull();
    expect(paperclipButtons[0].textContent).toBe('');
    // The picker's own (removed) trigger class must never appear.
    expect(container.querySelector('.oxp-attachment-btn')).toBeNull();

    composer.destroy();
  });

  it('paste_with_image_stages_it_without_sending_a_message', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);

    // jsdom doesn't implement ClipboardEvent.clipboardData.files,
    // so we dispatch a plain Event with clipboardData stubbed via Object.defineProperty.
    // Our paste handler reads ev.clipboardData?.files, so this works.
    const file = new File([new Uint8Array(100)], 'screenshot.png', { type: 'image/png' });
    const stubClipboardData = {
      files: [file] as unknown as FileList,
    };
    // Use plain Event — ClipboardEvent may not be defined in jsdom
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: stubClipboardData,
      configurable: true,
    });

    textarea.dispatchEvent(pasteEvent);
    await drain(15);

    // UPLOAD-ON-STAGE: the eager background upload fires immediately on paste...
    expect(uploadAttachment).toHaveBeenCalledWith('r1', expect.any(Blob), expect.any(Object));
    // ...but no message is sent until the user explicitly hits send.
    expect(sendAttachmentMessage).not.toHaveBeenCalled();

    const tray = container.querySelector('.oxp-attachment-queue') as HTMLElement | null;
    expect(tray).not.toBeNull();
    expect(tray!.hidden).toBe(false);
    // Send becomes enabled with a staged attachment even though text is empty.
    expect(getSendBtn(container).disabled).toBe(false);

    composer.destroy();
  });

  it('drag_drop_stages_it_without_sending_a_message', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const root = container.querySelector('.oxp-composer') as HTMLElement;
    expect(root).not.toBeNull();

    const file = new File([new Uint8Array(100)], 'dropped.png', { type: 'image/png' });
    // jsdom lacks DragEvent — dispatch a plain Event and attach stub dataTransfer
    const stubDataTransfer = { files: [file] as unknown as FileList };
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: stubDataTransfer,
      configurable: true,
    });

    root.dispatchEvent(dropEvent);
    await drain(15);

    expect(uploadAttachment).toHaveBeenCalledWith('r1', expect.any(Blob), expect.any(Object));
    expect(sendAttachmentMessage).not.toHaveBeenCalled();
    expect(getSendBtn(container).disabled).toBe(false);

    composer.destroy();
  });

  it('multi_add_across_paste_and_drop_appends_to_the_same_tray', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    const root = container.querySelector('.oxp-composer') as HTMLElement;

    const pasted = new File([new Uint8Array(10)], 'pasted.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', { value: { files: [pasted] }, configurable: true });
    textarea.dispatchEvent(pasteEvent);
    await drain(15);

    const dropped = new File([new Uint8Array(10)], 'dropped.png', { type: 'image/png' });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [dropped] }, configurable: true });
    root.dispatchEvent(dropEvent);
    await drain(15);

    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('.oxp-attachment-item').length).toBe(2);

    composer.destroy();
  });

  it('composer_root_has_dragover_class_during_drag', () => {
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const root = container.querySelector('.oxp-composer') as HTMLElement;
    expect(root).not.toBeNull();

    // jsdom lacks DragEvent — use plain Event with preventDefault
    root.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    expect(root.classList.contains('oxp-composer-dragover')).toBe(true);

    root.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect(root.classList.contains('oxp-composer-dragover')).toBe(false);

    composer.destroy();
  });

  // ── Slice 4/5: combined text + staged-attachment send ────────────────────────

  async function stageOnePastedImage(container: HTMLElement): Promise<void> {
    const textarea = getInput(container);
    const file = new File([new Uint8Array(100)], 'photo.png', { type: 'image/png' });
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', { value: { files: [file] }, configurable: true });
    textarea.dispatchEvent(pasteEvent);
    await drain(15);
  }

  it('combined_send_fires_one_sendAttachmentMessage_with_caption_and_staged_attachments', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs({
      uploadResolve: {
        attachmentId: 'att-9',
        attachment: { id: 'att-9', mime: 'image/png', filename: 'photo.png', sizeBytes: 500, width: 10, height: 10 },
      },
    });
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    await stageOnePastedImage(container);

    const textarea = getInput(container);
    setInputValue(textarea, 'caption text');
    getSendBtn(container).click();
    await drain(20);

    expect(client.sendText).not.toHaveBeenCalled();
    expect(sendAttachmentMessage).toHaveBeenCalledTimes(1);
    const [roomIdArg, bodyArg, attachmentsArg] = (sendAttachmentMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      readonly { id: string; mime: string }[],
    ];
    expect(roomIdArg).toBe('r1');
    expect(bodyArg).toBe('caption text');
    expect(attachmentsArg).toHaveLength(1);
    expect(attachmentsArg[0]).toMatchObject({ id: 'att-9', mime: 'image/png' });

    // Tray + input clear on success; objectURL revoked with the staged item.
    expect(textarea.value).toBe('');
    expect(container.querySelector('.oxp-attachment-item')).toBeNull();

    composer.destroy();
  });

  it('combined_send_allows_staged_attachments_with_no_caption_text', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    await stageOnePastedImage(container);
    expect(getSendBtn(container).disabled).toBe(false);

    getSendBtn(container).click();
    await drain(20);

    expect(sendAttachmentMessage).toHaveBeenCalledTimes(1);
    const [, bodyArg] = (sendAttachmentMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(bodyArg).toBe('');

    composer.destroy();
  });

  it('send_stays_disabled_with_no_text_and_no_staged_attachments', () => {
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    expect(getSendBtn(container).disabled).toBe(true);

    composer.destroy();
  });

  it('upload_failure_blocks_send_and_keeps_the_tray_for_retry', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs({
      uploadReject: new Error('upload boom'),
    });
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    await stageOnePastedImage(container);

    // Send is still enabled (a staged item exists) — clicking it must await
    // the (failed) upload, never call sendAttachmentMessage, and leave the
    // failed item in the tray so the user can retry or remove it.
    getSendBtn(container).click();
    await drain(20);

    expect(sendAttachmentMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.oxp-attachment-item')).not.toBeNull();
    expect(container.querySelector('.oxp-composer-error')).not.toBeNull();

    composer.destroy();
  });

  // ── Review fix (HIGH, PR #88): cancel-during-await empty-send race ─────────
  //
  // #send() snapshots hasStaged BEFORE awaiting awaitAllUploaded(). If every
  // staged item is cancelled while that await is in flight, the staged list
  // goes to zero and awaitAllUploaded() resolves vacuously ([].every === true)
  // — without the re-check fix, that used to fall through to
  // sendAttachmentMessage(text, []), broadcasting a sealed envelope with an
  // empty attachments array (peers decode/render this as raw JSON text).
  //
  // The cancel button is disabled the instant #send() starts (setSendLocked),
  // so a real user's .click() cannot reach this race anymore (jsdom mirrors
  // real browsers: a disabled button's .click() no-ops, verified separately).
  // These tests exercise the underlying JS guard directly via a synthetic
  // dispatchEvent (bypasses the disabled-button activation gate, the same way
  // this file already synthesizes paste/drop events that aren't real user
  // gestures) — the guard must hold even for cancellation paths the UI-level
  // lock doesn't cover.
  it('cancelling_every_staged_item_during_send_with_no_caption_sends_nothing', async () => {
    let resolveUpload!: (v: { attachmentId: string; attachment: { id: string; mime: string; filename: string; sizeBytes: number } }) => void;
    const uploadAttachment = vi.fn(
      () => new Promise((resolve) => { resolveUpload = resolve; }),
    );
    const sendAttachmentMessage = vi.fn().mockResolvedValue({ msgId: 'should-not-happen' });
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    await stageOnePastedImage(container); // upload never resolves — item stays 'uploading'

    getSendBtn(container).click(); // enters #send(), awaits awaitAllUploaded()
    await drain(5);

    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn!.disabled).toBe(true); // UI-level defense-in-depth confirmed wired
    cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await drain(20);

    expect(sendAttachmentMessage).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
    void resolveUpload; // never invoked — the upload was aborted, not completed

    composer.destroy();
  });

  it('cancelling_every_staged_item_during_send_with_a_caption_falls_back_to_a_plain_text_send', async () => {
    const uploadAttachment = vi.fn(() => new Promise(() => {})); // never resolves
    const sendAttachmentMessage = vi.fn().mockResolvedValue({ msgId: 'should-not-happen' });
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    await stageOnePastedImage(container);
    setInputValue(getInput(container), 'caption survives');

    getSendBtn(container).click();
    await drain(5);

    const cancelBtn = container.querySelector('.oxp-attachment-cancel') as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await drain(20);

    expect(sendAttachmentMessage).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledWith('r1', 'caption survives', expect.anything());

    composer.destroy();
  });

  // ── 1A: Retry button aria-label (#1251) ──────────────────────────────────────

  it('retry_button_has_descriptive_aria_label', async () => {
    // 1A: bare "Retry" text is ambiguous in multi-context. Must have
    // aria-label="Retry sending message" for unambiguous SR announcement.
    const client = makeStubClient({ sendTextReject: new Error('net') });
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    setInputValue(getInput(container), 'msg');
    getSendBtn(container).click();
    await drain(20);

    const retryBtn = container.querySelector('.oxp-composer-error button') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn!.getAttribute('aria-label')).toBe('Retry sending message');

    composer.destroy();
  });

  // ── 1E: Textarea data-loss vector (#1251) — CM3 followup ─────────────────────

  it('textarea_disabled_during_send_clears_on_success', async () => {
    // 1E original: textarea enabled during send → user types → success clears, losing input.
    // Fix: disable textarea during send (data-loss impossible by impossibility of typing).
    // CM3 (code MAJOR): the preserve-branch was DEAD CODE — textarea.disabled=true prevents
    // all user keyboard input, so textarea.value cannot change during send.
    // Accept: textarea disabled during send = data preserved by impossibility.
    // Updated test: verifies textarea is disabled in-flight and cleared (not preserved) on success.
    let resolveSend!: (v: { msgId: string }) => void;
    const client = {
      list: (_roomId: string, _args: { limit: number }) => Promise.resolve({ items: [], hasNext: false }),
      subscribe: () => () => {},
      sendText: vi.fn(
        () => new Promise<{ msgId: string }>((resolve) => { resolveSend = resolve; }),
      ),
    };

    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'first message');
    getSendBtn(container).click();

    // While in-flight, textarea must be disabled — user cannot type new content
    await drain(3);
    expect(textarea.disabled).toBe(true);

    // Resolve the send — textarea must be cleared and re-enabled
    resolveSend({ msgId: 'msg1' });
    await drain(20);

    // textarea cleared (sent text gone) + re-enabled
    expect(textarea.value).toBe('');
    expect(textarea.disabled).toBe(false);

    composer.destroy();
  });

  // ── 1F: #updateState called on mount — rigorously tests the actual invariant (#1251) ─────

  it('calls_updateState_on_mount_to_reflect_initial_value', () => {
    // CM1 (code MAJOR): old test was satisfied by DOM defaults — reverting this.#updateState()
    // from mount() left test GREEN (hint text is set via createElement + textContent in DOM init,
    // NOT by #updateState). Fix: test must use setInitialText() to pre-fill textarea BEFORE mount,
    // then verify send button is ENABLED (reflecting non-empty value). Reverting #updateState()
    // would leave send button disabled (DOM default) — proving the test is load-bearing.
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });

    // Pre-fill initial text before mount — simulates programmatic pre-fill scenario.
    // setInitialText() stores the value; mount() picks it up and #updateState() enables send.
    composer.setInitialText('initial value');
    composer.mount();

    // Send button MUST be enabled — only possible if #updateState() ran after textarea was pre-filled.
    // If #updateState() is removed from mount(), textarea.value='initial value' but send stays disabled
    // (DOM default: button.disabled=true, only #updateState() enables it for non-empty content).
    expect(getSendBtn(container).disabled).toBe(false);

    // Verify the hint element exists and has content (mount wired it up)
    const hint = container.querySelector('#oxp-send-hint') as HTMLElement | null;
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBeTruthy();

    composer.destroy();
  });

  // ── 1G: Stale "Message is empty" hint during send (#1251) ────────────────────

  it('send_hint_reads_sending_during_in_flight', async () => {
    // 1G: during #sending=true, hint still reads "Message is empty" → SR announces wrong state.
    // Fix: if #sending, hint reads "Sending message…"
    let resolveSend!: (v: { msgId: string }) => void;
    const client = {
      list: (_roomId: string, _args: { limit: number }) => Promise.resolve({ items: [], hasNext: false }),
      subscribe: () => () => {},
      sendText: vi.fn(
        () => new Promise<{ msgId: string }>((resolve) => { resolveSend = resolve; }),
      ),
    };

    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const textarea = getInput(container);
    setInputValue(textarea, 'sending this');
    getSendBtn(container).click();
    await drain(3);

    // While in-flight, hint should reflect "Sending" state
    const hint = container.querySelector('#oxp-send-hint') as HTMLElement | null;
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain('Sending');

    // Resolve send so composer cleans up properly
    resolveSend({ msgId: 'msg1' });
    await drain(20);

    composer.destroy();
  });

  // ── W9: Product card attachment ─────────────────────────────────────────────

  it('forwards_productRef_and_productMeta_to_sendText', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const productMeta = {
      title: 'Widget Pro',
      price: '999',
      currency: 'USD',
      imageUrl: 'https://example.com/img.png',
      productUrl: 'https://example.com/p/1',
    };

    composer.setProductCard('sku-1', productMeta);
    setInputValue(getInput(container), 'check this');
    getSendBtn(container).click();
    await drain(20);

    expect(client.sendText).toHaveBeenCalledOnce();
    expect(client.sendText).toHaveBeenCalledWith('r1', 'check this', {
      productRef: 'sku-1',
      productMeta,
    });

    composer.destroy();
  });

  it('forwards_productRef_and_productMeta_to_sendTextOptimistic_when_e2ee', async () => {
    const client = makeStubClient({ hasE2ee: true });
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const productMeta = {
      title: 'Widget Pro',
      price: '999',
      currency: 'USD',
      imageUrl: 'https://example.com/img.png',
      productUrl: 'https://example.com/p/1',
    };

    composer.setProductCard('sku-2', productMeta);
    setInputValue(getInput(container), 'e2ee product');
    getSendBtn(container).click();
    await drain(20);

    expect(client.sendText).not.toHaveBeenCalled();
    const optimistic = (client as ReturnType<typeof makeStubClient> & { sendTextOptimistic: ReturnType<typeof vi.fn> }).sendTextOptimistic;
    expect(optimistic).toHaveBeenCalledOnce();
    expect(optimistic).toHaveBeenCalledWith('r1', 'e2ee product', {
      productRef: 'sku-2',
      productMeta,
    });

    composer.destroy();
  });

  it('clearProductCard_prevents_sending_product_card', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const productMeta = {
      title: 'Widget Pro',
      price: '999',
      currency: 'USD',
      imageUrl: 'https://example.com/img.png',
      productUrl: 'https://example.com/p/1',
    };

    composer.setProductCard('sku-1', productMeta);
    composer.clearProductCard();
    setInputValue(getInput(container), 'plain text');
    getSendBtn(container).click();
    await drain(20);

    expect(client.sendText).toHaveBeenCalledWith('r1', 'plain text', {});

    composer.destroy();
  });

  it('setReplyTarget_renders_preview_and_send_includes_threadRootMsgId', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    composer.setReplyTarget({ msgId: 'root-1', sender: 'Alice', body: 'original message' });

    const replyEl = container.querySelector('.oxp-composer-reply') as HTMLElement;
    expect(replyEl).not.toBeNull();
    expect(replyEl.hidden).toBe(false);
    expect(replyEl.textContent).toContain('Alice');
    expect(replyEl.textContent).toContain('original message');

    setInputValue(getInput(container), 'reply text');
    getSendBtn(container).click();
    await drain(20);

    expect(client.sendText).toHaveBeenCalledWith('r1', 'reply text', { threadRootMsgId: 'root-1' });

    // After send the reply preview is cleared.
    expect(replyEl.hidden).toBe(true);

    composer.destroy();
  });

  it('cancel_reply_button_clears_target', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    composer.setReplyTarget({ msgId: 'root-1', sender: 'Alice', body: 'original message' });
    const replyEl = container.querySelector('.oxp-composer-reply') as HTMLElement;
    expect(replyEl.hidden).toBe(false);

    const cancelBtn = container.querySelector('.oxp-composer-reply-cancel') as HTMLButtonElement;
    cancelBtn.click();
    await drain();

    expect(replyEl.hidden).toBe(true);

    composer.destroy();
  });

  it('escape_key_clears_reply_target', async () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    composer.setReplyTarget({ msgId: 'root-1', sender: 'Alice', body: 'original message' });
    const replyEl = container.querySelector('.oxp-composer-reply') as HTMLElement;
    expect(replyEl.hidden).toBe(false);

    const textarea = getInput(container);
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await drain();

    expect(replyEl.hidden).toBe(true);

    composer.destroy();
  });

  it('reply_preview_bar_uses_status_role_not_region', () => {
    // review pr-review-council 2026-07-14: role="region" is a landmark meant
    // for significant persistent sections; this bar is small/transient and
    // appears/disappears with every reply, which is screen-reader landmark
    // noise. role="status" carries an implicit polite live region, so the
    // explicit aria-live is redundant and dropped. aria-label is kept.
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const replyEl = container.querySelector('.oxp-composer-reply') as HTMLElement;
    expect(replyEl.getAttribute('role')).toBe('status');
    expect(replyEl.getAttribute('aria-live')).toBeNull();
    expect(replyEl.getAttribute('aria-label')).not.toBeNull();

    composer.destroy();
  });

  // ── P0: Voice messages ───────────────────────────────────────────────────────

  function makeMockVoiceRecorder(opts: { mime?: string; durationMs?: number; blob?: Blob } = {}) {
    const mime = opts.mime ?? 'audio/mp4';
    const blob = opts.blob ?? new Blob(['audio'], { type: mime });
    const durationMs = opts.durationMs ?? 0;
    return {
      durationMs: vi.fn(() => durationMs),
      stop: vi.fn(() => Promise.resolve({ blob, durationMs, mime })),
      cancel: vi.fn(),
    };
  }

  it('mic_button_hidden_without_attachment_capability', () => {
    const client = makeStubClient({});
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    expect(container.querySelector('.oxp-composer-mic-btn')).toBeNull();
    composer.destroy();
  });

  it('mic_button_hidden_without_mediaDevices', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('navigator', { language: 'en-US' });
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    expect(container.querySelector('.oxp-composer-mic-btn')).toBeNull();
    composer.destroy();
  });

  it('mic_button_visible_when_both_gates_pass', () => {
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement | null;
    expect(micBtn).not.toBeNull();
    expect(micBtn!.getAttribute('aria-label')).toBe('Record voice message');
    composer.destroy();
  });

  it('record_and_stop_opens_voice_preview_no_auto_upload', async () => {
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    vi.mocked(createVoiceRecorder).mockResolvedValue(
      makeMockVoiceRecorder({ mime: 'audio/mp4', durationMs: 12_300, blob }) as any,
    );

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    expect(createVoiceRecorder).toHaveBeenCalledOnce();
    expect(container.querySelector('.oxp-composer-recording')).not.toBeNull();
    expect(container.querySelector('.oxp-composer-main')?.hidden).toBe(true);

    const stopBtn = container.querySelector('.oxp-recording-stop-btn') as HTMLButtonElement;
    stopBtn.click();
    await drain(15);

    // Stop finalizes the blob and enters the pre-send preview, not upload.
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(sendAttachmentMessage).not.toHaveBeenCalled();

    const preview = container.querySelector('.oxp-composer-voice-preview') as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview.hidden).toBe(false);

    const audio = container.querySelector('.oxp-voice-preview-audio') as HTMLAudioElement;
    expect(audio).not.toBeNull();
    expect(audio.getAttribute('src')).toBeTruthy();

    expect(container.querySelector('.oxp-composer-recording')?.hidden).toBe(true);
    expect(container.querySelector('.oxp-composer-main')?.hidden).toBe(false);

    composer.destroy();
  });

  it('preview_send_uploads_voice_and_sends_with_caption_and_durationMs', async () => {
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    vi.mocked(createVoiceRecorder).mockResolvedValue(
      makeMockVoiceRecorder({ mime: 'audio/mp4', durationMs: 12_300, blob }) as any,
    );

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    const stopBtn = container.querySelector('.oxp-recording-stop-btn') as HTMLButtonElement;
    stopBtn.click();
    await drain(15);

    const audio = container.querySelector('.oxp-voice-preview-audio') as HTMLAudioElement;
    const objectURL = audio.getAttribute('src')!;

    const textarea = getInput(container);
    setInputValue(textarea, 'voice caption');

    const revokeSpy = vi.spyOn(globalThis.URL, 'revokeObjectURL');

    const previewSend = container.querySelector('.oxp-voice-preview-send') as HTMLButtonElement;
    expect(previewSend).not.toBeNull();
    expect(previewSend.disabled).toBe(false);
    previewSend.click();
    await drain(20);

    expect(uploadAttachment).toHaveBeenCalledOnce();
    expect(uploadAttachment).toHaveBeenCalledWith('r1', blob, { mimeType: 'audio/mp4', filename: 'voice.mp4' });

    expect(sendAttachmentMessage).toHaveBeenCalledOnce();
    const [roomIdArg, bodyArg, attachmentsArg] = (sendAttachmentMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      readonly { id: string; durationMs?: number }[],
    ];
    expect(roomIdArg).toBe('r1');
    expect(bodyArg).toBe('voice caption');
    expect(attachmentsArg).toHaveLength(1);
    expect(attachmentsArg[0]).toMatchObject({ id: 'att-1', mime: 'image/png', durationMs: 12_300 });

    // Success clears textarea, preview, and revokes the object URL.
    expect(textarea.value).toBe('');
    expect(container.querySelector('.oxp-composer-voice-preview')?.hidden).toBe(true);
    expect(revokeSpy).toHaveBeenCalledWith(objectURL);

    revokeSpy.mockRestore();
    composer.destroy();
  });

  it('preview_send_works_without_caption', async () => {
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    vi.mocked(createVoiceRecorder).mockResolvedValue(
      makeMockVoiceRecorder({ mime: 'audio/mp4', durationMs: 5_000, blob }) as any,
    );

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    const stopBtn = container.querySelector('.oxp-recording-stop-btn') as HTMLButtonElement;
    stopBtn.click();
    await drain(15);

    const previewSend = container.querySelector('.oxp-voice-preview-send') as HTMLButtonElement;
    expect(previewSend.disabled).toBe(false);
    previewSend.click();
    await drain(20);

    expect(uploadAttachment).toHaveBeenCalledOnce();
    expect(sendAttachmentMessage).toHaveBeenCalledOnce();
    const [, bodyArg] = (sendAttachmentMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(bodyArg).toBe('');

    composer.destroy();
  });

  it('preview_discard_revokes_objectURL_and_sends_nothing', async () => {
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    vi.mocked(createVoiceRecorder).mockResolvedValue(
      makeMockVoiceRecorder({ mime: 'audio/mp4', durationMs: 8_000, blob }) as any,
    );

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    const stopBtn = container.querySelector('.oxp-recording-stop-btn') as HTMLButtonElement;
    stopBtn.click();
    await drain(15);

    const audio = container.querySelector('.oxp-voice-preview-audio') as HTMLAudioElement;
    const objectURL = audio.getAttribute('src')!;

    const revokeSpy = vi.spyOn(globalThis.URL, 'revokeObjectURL');

    const previewDiscard = container.querySelector('.oxp-voice-preview-discard') as HTMLButtonElement;
    expect(previewDiscard).not.toBeNull();
    previewDiscard.click();
    await drain(10);

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(sendAttachmentMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.oxp-composer-voice-preview')?.hidden).toBe(true);
    expect(revokeSpy).toHaveBeenCalledWith(objectURL);

    revokeSpy.mockRestore();
    composer.destroy();
  });

  it('auto_stop_at_60s_enters_preview_not_send', async () => {
    vi.useFakeTimers();
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    vi.mocked(createVoiceRecorder).mockResolvedValue(
      makeMockVoiceRecorder({ mime: 'audio/mp4', durationMs: 60_000, blob }) as any,
    );

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    try {
      const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
      micBtn.click();
      // let the async getUserMedia/createVoiceRecorder resolve
      await vi.advanceTimersByTimeAsync(1);

      // hit the 60 s auto-cap
      await vi.advanceTimersByTimeAsync(60_000);
      await drain(10);

      expect(uploadAttachment).not.toHaveBeenCalled();
      expect(sendAttachmentMessage).not.toHaveBeenCalled();

      const preview = container.querySelector('.oxp-composer-voice-preview') as HTMLElement;
      expect(preview).not.toBeNull();
      expect(preview.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    composer.destroy();
  });

  it('destroy_during_preview_revokes_objectURL', async () => {
    const blob = new Blob(['voice'], { type: 'audio/mp4' });
    vi.mocked(createVoiceRecorder).mockResolvedValue(
      makeMockVoiceRecorder({ mime: 'audio/mp4', durationMs: 10_000, blob }) as any,
    );

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    const stopBtn = container.querySelector('.oxp-recording-stop-btn') as HTMLButtonElement;
    stopBtn.click();
    await drain(15);

    const audio = container.querySelector('.oxp-voice-preview-audio') as HTMLAudioElement;
    const objectURL = audio.getAttribute('src')!;

    const revokeSpy = vi.spyOn(globalThis.URL, 'revokeObjectURL');
    composer.destroy();
    await drain(5);

    expect(revokeSpy).toHaveBeenCalledWith(objectURL);
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(sendAttachmentMessage).not.toHaveBeenCalled();

    revokeSpy.mockRestore();
  });

  it('mic_and_paperclip_title_attrs_in_both_languages', () => {
    const client = { ...makeStubClient({}), ...makeAttachmentStubs() };

    const composerEn = new Composer({ client, roomId: 'r1', container, lang: 'en' });
    composerEn.mount();
    const micBtnEn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    const paperclipEn = container.querySelector('.oxp-composer-attachment-btn') as HTMLButtonElement;
    expect(micBtnEn.getAttribute('title')).toBe('Record voice message');
    expect(paperclipEn.getAttribute('title')).toBe('Attach file');
    composerEn.destroy();

    container.innerHTML = '';
    const composerRu = new Composer({ client, roomId: 'r1', container, lang: 'ru' });
    composerRu.mount();
    const micBtnRu = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    const paperclipRu = container.querySelector('.oxp-composer-attachment-btn') as HTMLButtonElement;
    expect(micBtnRu.getAttribute('title')).toBe('Записать голосовое');
    expect(paperclipRu.getAttribute('title')).toBe('Прикрепить файл');
    composerRu.destroy();
  });

  it('cancel_voice_recording_sends_nothing', async () => {
    vi.mocked(createVoiceRecorder).mockResolvedValue(makeMockVoiceRecorder() as any);

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    const cancelBtn = container.querySelector('.oxp-recording-cancel-btn') as HTMLButtonElement;
    cancelBtn.click();
    await drain(10);

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(sendAttachmentMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.oxp-composer-main')?.hidden).toBe(false);

    composer.destroy();
  });

  it('destroy_mid_recording_cancels_recorder', async () => {
    const mockRecorder = makeMockVoiceRecorder();
    vi.mocked(createVoiceRecorder).mockResolvedValue(mockRecorder as any);

    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;
    micBtn.click();
    await drain(10);

    composer.destroy();
    await drain(5);

    expect(mockRecorder.cancel).toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(sendAttachmentMessage).not.toHaveBeenCalled();
  });

  it('mic_double_click_before_createVoiceRecorder_resolves_starts_one_stream', async () => {
    const { uploadAttachment, sendAttachmentMessage } = makeAttachmentStubs();
    const client = { ...makeStubClient({}), uploadAttachment, sendAttachmentMessage };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const micBtn = container.querySelector('.oxp-composer-mic-btn') as HTMLButtonElement;

    const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const getUserMedia = vi.fn().mockImplementation(() => {
      const track = { stop: vi.fn() };
      const stream = { getTracks: () => [track] };
      tracks.push(track);
      return Promise.resolve(stream);
    });
    vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: { getUserMedia } });

    vi.mocked(createVoiceRecorder).mockClear();
    vi.mocked(createVoiceRecorder).mockImplementation(async () => {
      const stream = await getUserMedia({ audio: true } as unknown as MediaStreamConstraints);
      const track = stream.getTracks()[0];
      const blob = new Blob(['voice'], { type: 'audio/mp4' });
      return {
        durationMs: vi.fn(() => 0),
        stop: vi.fn(() => Promise.resolve({ blob, durationMs: 0, mime: 'audio/mp4' })),
        cancel: () => {
          track.stop();
        },
      } as unknown as VoiceRecorder;
    });

    // Two synchronous clicks before the async recorder resolves
    micBtn.click();
    micBtn.click();
    await drain(10);

    expect(createVoiceRecorder).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(tracks).toHaveLength(1);

    composer.destroy();
    await drain(2);

    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledOnce();
    }
  });
});

