/**
 * message-list-i18n.test.ts — i18n wire-in for MessageList.
 *
 * Before this change `MessageListOptions.lang` was accepted but never read
 * for strings (tombstone / unseal-error / aria-labels always rendered
 * English regardless of `lang`). These tests prove the full construction →
 * render path picks up the resolved locale for the two representative
 * surfaces called out in the gap report: the tombstone and the unseal-error
 * placeholder (visible text + aria-label).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MessageList } from '../ui/message-list.js';
import type { MessageListClient, MessageRow } from '../ui/message-list.js';

function makeRow(overrides: Partial<MessageRow> & { senderUid: string }): MessageRow {
  return {
    seq: 1,
    msgId: crypto.randomUUID(),
    senderUid: overrides.senderUid,
    sealed: new ArrayBuffer(0),
    plaintext: new TextEncoder().encode(overrides.text ?? 'hello'),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    ...overrides,
  };
}

function makeMockClient(rows: MessageRow[]): MessageListClient {
  return {
    list: async () => ({ items: rows, hasNext: false }),
    subscribe: () => () => {},
    sendReaction: async () => {},
    removeReaction: async () => {},
  };
}

describe('MessageList i18n', () => {
  let container: HTMLDivElement;
  let ml: MessageList | null = null;

  afterEach(() => {
    ml?.destroy();
    ml = null;
    if (container?.parentNode) container.parentNode.removeChild(container);
  });

  function mountWith(rows: MessageRow[], lang?: string): Promise<HTMLElement> {
    container = document.createElement('div');
    container.style.height = '400px';
    container.style.overflow = 'auto';
    document.body.appendChild(container);
    const client = makeMockClient(rows);
    ml = new MessageList({ client, roomId: 'r1', container, lang, selfUid: 'u1' });
    return ml.mount().then(() => container.querySelector('[role="article"]') as HTMLElement);
  }

  it('renders the English tombstone by default (no lang given)', async () => {
    const bubble = await mountWith([
      makeRow({ senderUid: 'u1', seq: 1, deletedAt: new Date().toISOString() }),
    ]);
    expect(bubble.textContent).toContain('This message was deleted');
  });

  it('renders the Russian tombstone for lang="ru"', async () => {
    const bubble = await mountWith([
      makeRow({ senderUid: 'u1', seq: 1, deletedAt: new Date().toISOString() }),
    ], 'ru');
    expect(bubble.textContent).toContain('Это сообщение удалено');
    expect(bubble.getAttribute('aria-label')).toContain('Это сообщение удалено');
  });

  it('renders the Russian unseal-error placeholder (visible + aria) for lang="ru"', async () => {
    const bubble = await mountWith([
      makeRow({ senderUid: 'u2', seq: 1, plaintext: undefined, text: undefined, unsealError: 'auth' }),
    ], 'ru');
    expect(bubble.querySelector('.oxp-unseal-error')?.textContent).toContain('не удалось расшифровать');
    expect(bubble.getAttribute('aria-label')).toContain('не удалось расшифровать');
    // aria variant drops the lock glyph (screen readers already announce "locked")
    expect(bubble.getAttribute('aria-label')).not.toContain('\u{1F512}');
    // visible variant keeps the glyph
    expect(bubble.querySelector('.oxp-unseal-error')?.textContent).toContain('\u{1F512}');
  });

  it('renders the Russian "Add reaction" / "You" sender label for lang="ru"', async () => {
    const bubble = await mountWith([makeRow({ senderUid: 'u1', seq: 1 })], 'ru');
    expect(bubble.querySelector('.oxp-bubble-sender')?.textContent).toBe('Вы');
    expect(bubble.querySelector('.oxp-reaction-heart-btn')?.getAttribute('aria-label')).toBe('Добавить реакцию');
  });

  it('falls back to English for an unsupported lang tag', async () => {
    const bubble = await mountWith([
      makeRow({ senderUid: 'u1', seq: 1, deletedAt: new Date().toISOString() }),
    ], 'fr-FR');
    expect(bubble.textContent).toContain('This message was deleted');
  });
});
