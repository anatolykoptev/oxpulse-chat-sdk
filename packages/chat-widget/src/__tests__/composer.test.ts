/**
 * composer.test.ts — TDD RED phase.
 *
 * Tests: Composer class (W2.2 slice 2 acceptance criteria + slice 4 attachment additions).
 * Stub client mirrors element.ts stub pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Composer } from '../ui/composer.js';
import { MAX_BODY_CHARS } from '../utils/textfield-helpers.js';

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
    // sendFile must be present for paperclip to render
    const client = {
      ...makeStubClient({}),
      sendFile: vi.fn().mockResolvedValue({ msgId: 'm', attachmentId: 'a' }),
    };
    const composer = new Composer({ client, roomId: 'r1', container });
    composer.mount();

    const btn = container.querySelector('.oxp-composer-attachment-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Attach files');

    composer.destroy();
  });

  it('paste_with_image_triggers_upload', async () => {
    const sendFile = vi.fn().mockResolvedValue({ msgId: 'msg-paste', attachmentId: 'att-paste' });
    const client = { ...makeStubClient({}), sendFile };
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
    await drain(10);

    expect(sendFile).toHaveBeenCalledWith(
      'r1',
      expect.any(Blob),
      expect.any(Object),
    );

    composer.destroy();
  });

  it('drag_drop_triggers_upload', async () => {
    const sendFile = vi.fn().mockResolvedValue({ msgId: 'msg-drop', attachmentId: 'att-drop' });
    const client = { ...makeStubClient({}), sendFile };
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
    await drain(10);

    expect(sendFile).toHaveBeenCalledWith(
      'r1',
      expect.any(Blob),
      expect.any(Object),
    );

    composer.destroy();
  });

  it('composer_root_has_dragover_class_during_drag', () => {
    const client = {
      ...makeStubClient({}),
      sendFile: vi.fn().mockResolvedValue({ msgId: 'm', attachmentId: 'a' }),
    };
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
});

