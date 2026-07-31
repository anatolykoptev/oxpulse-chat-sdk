/**
 * @oxpulse/chat-widget — i18n locale table.
 *
 * The widget accepted a `lang` constructor/attribute option since W2.1 but never
 * read it for any string — every user-facing string (tombstone, unseal-error,
 * composer, aria-labels) was hardcoded English. This module is the fix: a flat
 * `Record<Locale, Record<LocaleKey, string>>` lookup + a `t()` helper.
 *
 * No external i18n library — the widget is zero-dependency by design and the
 * CDN bundle is size-budgeted (see esbuild.cdn.mjs FF-1 gate, 250 KB gzip).
 * A plain table + `{placeholder}` substitution covers every string this
 * package renders without pulling in ICU/CLDR plural-rule machinery.
 *
 * Interpolation: templates use `{name}` placeholders, substituted by `t()`.
 * Fallback chain: requested locale → `en` (per-key, via `lookupWithFallback`)
 * → the raw key itself as an absolute last resort — `t()` never returns
 * `undefined` or throws.
 */

export type Locale = 'en' | 'ru';

/** Locales the widget ships a translation table for. */
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ru'];

export type LocaleKey =
  // Message list — tombstone / unseal-error / bubble
  | 'tombstone'
  | 'unsealError'
  | 'unsealErrorAria'
  | 'senderYou'
  | 'bubbleAriaLabel'
  | 'addReactionAria'
  | 'removeReactionAria'
  | 'heartButtonTitle'
  | 'retryLoadingMessagesAria'
  | 'retry'
  // Reactions
  | 'reactionsGroupAria'
  | 'chooseReactionAria'
  | 'youReactedSuffix'
  // Reply
  | 'replyToMessageAria'
  | 'replyingToMessageAria'
  | 'cancelReply'
  | 'replyToLabel'
  | 'replyOriginalUnavailable'
  // Composer
  | 'composerPlaceholder'
  | 'messageInputAria'
  | 'sendMessageAria'
  | 'send'
  | 'messageEmpty'
  | 'sendingMessage'
  | 'messageExceedsLimit'
  | 'charactersRemaining'
  | 'retrySendingMessageAria'
  | 'attachFilesAria'
  | 'recordVoiceMessageAria'
  | 'recordVoiceMessageTitle'
  | 'stopRecordingAria'
  | 'cancelRecordingAria'
  | 'recordingLabel'
  | 'voicePreviewLabel'
  | 'sendVoiceMessageAria'
  | 'discardVoiceMessageAria'
  | 'voiceSlideHint'
  | 'voiceReleaseToCancelHint'
  | 'voiceBubbleGroupAria'
  | 'voicePlayAria'
  | 'voicePauseAria'
  | 'voiceSpeedAria'
  | 'voiceWaveformSeekAria'
  | 'voicePlaybackErrorAria'
  | 'attachFilesTitle'
  // Attachment picker
  | 'chooseFilesToAttachAria'
  | 'attachmentTrayAria'
  | 'cancelUploadOfAria'
  | 'uploadingProgressAria'
  | 'announceUploadingFile'
  | 'announceFileUploaded'
  | 'announceUploadFailedFile'
  | 'uploadFailed'
  | 'queueUploadingCount'
  | 'queueDoneCount'
  | 'queueFailedCount'
  // Attachment rendering (message bubbles)
  | 'attachmentUnavailableAria'
  | 'imageAria'
  | 'audioAria'
  | 'fileAria'
  // Product card (W9)
  | 'productViewAria'
  | 'productCardAttached'
  | 'removeProductCard'
  // Reconnect banner
  | 'sessionExpired'
  | 'refresh'
  | 'refreshSessionAria'
  | 'connectionLostReconnecting'
  | 'connected'
  | 'couldNotReconnect'
  | 'reconnect'
  | 'retryConnectionManuallyAria'
  // Element loading state
  | 'chatLoading'
  // Roster role badge (P5)
  | 'roleBadgeModerator'
  | 'roleBadgeOwner'
  // Typing indicator (#120)
  | 'typingOneUser'
  | 'typingTwoUsers'
  | 'typingMultiple'
  | 'typingAriaLabel'
  // Presence (#121)
  | 'presenceOnline'
  | 'presenceLastSeen'
  | 'presenceLastSeenAria'
  // Read receipts (#122)
  | 'readReceiptSent'
  | 'readReceiptDelivered'
  | 'readReceiptRead'
  | 'readReceiptReadBy'
  | 'readReceiptAria'
  // Emoji picker (#127)
  | 'emojiPickerAria'
  | 'emojiPickerSearch'
  | 'emojiPickerSearchAria'
  | 'emojiPickerNoResults'
  | 'emojiPickerBtnAria'
  // Threads (#126)
  | 'threadTitle'
  | 'threadReplies'
  | 'threadReplyCount'
  | 'threadCloseAria'
  | 'threadSendReply'
  | 'threadReplyPlaceholder'
  | 'threadLoading'
  | 'threadEmpty'
  | 'threadError'
  // Pinned messages banner (#228)
  | 'pinnedBannerTitle'
  | 'pinnedBannerPinnedBy'
  | 'pinnedBannerNotLoaded'
  | 'pinnedBannerCloseAria'
  | 'pinnedBannerPrevAria'
  | 'pinnedBannerNextAria'
  | 'pinnedBannerJumpAria'
  | 'pinMessageAria'
  | 'unpinMessageAria';

type LocaleTable = Record<LocaleKey, string>;

/** `en` is the source-of-truth wording — every string verbatim as it shipped
 *  before this i18n layer existed. Never reword these without a design review;
 *  changing them changes copy for every English-speaking user. */
const en: LocaleTable = {
  tombstone: 'This message was deleted',
  unsealError: "\u{1F512} This message couldn't be decrypted",
  unsealErrorAria: "This message couldn't be decrypted",
  senderYou: 'You',
  bubbleAriaLabel: 'Message from {sender} at {time}: {body}',
  addReactionAria: 'Add reaction',
  removeReactionAria: 'Remove reaction',
  heartButtonTitle: 'React ❤ · hold for more',
  retryLoadingMessagesAria: 'Retry loading messages',
  retry: 'Retry',

  reactionsGroupAria: 'Reactions',
  chooseReactionAria: 'Choose reaction',
  youReactedSuffix: ', you reacted',

  replyToMessageAria: 'Reply to message',
  replyingToMessageAria: 'Replying to message',
  cancelReply: 'Cancel reply',
  replyToLabel: 'Reply to {sender}',
  replyOriginalUnavailable: 'Original message unavailable',

  composerPlaceholder: 'Type a message…',
  messageInputAria: 'Message input',
  sendMessageAria: 'Send message',
  send: 'Send',
  messageEmpty: 'Message is empty',
  sendingMessage: 'Sending message…',
  messageExceedsLimit: 'Message exceeds character limit',
  charactersRemaining: '{remaining} characters remaining',
  retrySendingMessageAria: 'Retry sending message',
  attachFilesAria: 'Attach files',
  attachFilesTitle: 'Attach file',
  recordVoiceMessageAria: 'Record voice message',
  recordVoiceMessageTitle: 'Record voice message',
  stopRecordingAria: 'Stop recording',
  cancelRecordingAria: 'Cancel recording',
  recordingLabel: 'Recording {duration}',
  voicePreviewLabel: 'Voice preview',
  sendVoiceMessageAria: 'Send voice message',
  discardVoiceMessageAria: 'Discard voice message',
  voiceSlideHint: 'Slide ◂ to lock · ▴ up to cancel',
  voiceReleaseToCancelHint: 'Release to cancel',
  voiceBubbleGroupAria: 'Voice message',
  voicePlayAria: 'Play voice message',
  voicePauseAria: 'Pause voice message',
  voiceSpeedAria: 'Playback speed',
  voiceWaveformSeekAria: 'Voice waveform — click or arrow keys to seek',
  voicePlaybackErrorAria: 'Voice playback failed',

  chooseFilesToAttachAria: 'Choose files to attach',
  attachmentTrayAria: 'Attachments to send',
  cancelUploadOfAria: 'Cancel upload of {name}',
  uploadingProgressAria: 'Uploading…',
  announceUploadingFile: 'Uploading {name}',
  announceFileUploaded: '{name} uploaded',
  announceUploadFailedFile: 'Upload failed: {name}',
  uploadFailed: 'Upload failed',
  queueUploadingCount: '{n} uploading',
  queueDoneCount: '{n} done',
  queueFailedCount: '{n} failed',

  attachmentUnavailableAria: 'Attachment: {name} (unavailable)',
  imageAria: 'Image: {name}, {size}',
  audioAria: 'Audio: {name}, {size}',
  fileAria: 'File: {name}, {size}',
  productViewAria: 'View product: {title}',
  productCardAttached: 'Product card attached: {title}',
  removeProductCard: 'Remove product card',

  sessionExpired: 'Session expired.',
  refresh: 'Refresh',
  refreshSessionAria: 'Refresh session',
  connectionLostReconnecting: 'Connection lost. Reconnecting… (attempt {n})',
  connected: 'Connected.',
  couldNotReconnect: 'Could not reconnect.',
  reconnect: 'Reconnect',
  retryConnectionManuallyAria: 'Retry connection manually',

  chatLoading: 'Chat loading…',

  roleBadgeModerator: 'mod',
  roleBadgeOwner: 'owner',
  typingOneUser: '{user} is typing…',
  typingTwoUsers: '{user1} and {user2} are typing…',
  typingMultiple: '{user1}, {user2} and {n} others are typing…',
  typingAriaLabel: 'Users typing: {names}',
  presenceOnline: 'Online',
  presenceLastSeen: 'last seen {time}',
  presenceLastSeenAria: '{name} last seen {time}',
  readReceiptSent: 'Sent',
  readReceiptDelivered: 'Delivered',
  readReceiptRead: 'Read',
  readReceiptReadBy: 'Read by {n}',
  readReceiptAria: 'Message status: {status}',
  emojiPickerAria: 'Emoji picker',
  emojiPickerSearch: 'Search emoji…',
  emojiPickerSearchAria: 'Search emoji',
  emojiPickerNoResults: 'No emoji found',
  emojiPickerBtnAria: 'Open emoji picker',
  threadTitle: 'Thread',
  threadReplies: '{n} replies',
  threadReplyCount: '{n} reply',
  threadCloseAria: 'Close thread',
  threadSendReply: 'Send reply',
  threadReplyPlaceholder: 'Reply to thread…',
  threadLoading: 'Loading thread…',
  threadEmpty: 'No replies yet',
  threadError: 'Failed to load thread',

  pinnedBannerTitle: 'Pinned message',
  pinnedBannerPinnedBy: 'Pinned by {name}',
  pinnedBannerNotLoaded: 'Pinned message not loaded',
  pinnedBannerCloseAria: 'Close pinned banner',
  pinnedBannerPrevAria: 'Previous pinned message',
  pinnedBannerNextAria: 'Next pinned message',
  pinnedBannerJumpAria: 'Jump to message',
  pinMessageAria: 'Pin message',
  unpinMessageAria: 'Unpin message',
};

/** Russian translations. oxpulse's userbase is heavily RU — this is the first
 *  non-English locale, so every key ships fully translated (no partial rows). */
const ru: LocaleTable = {
  tombstone: 'Это сообщение удалено',
  unsealError: '\u{1F512} Это сообщение не удалось расшифровать',
  unsealErrorAria: 'Это сообщение не удалось расшифровать',
  senderYou: 'Вы',
  bubbleAriaLabel: 'Сообщение от {sender}, {time}: {body}',
  addReactionAria: 'Добавить реакцию',
  removeReactionAria: 'Убрать реакцию',
  heartButtonTitle: 'Реакция ❤ · удержите для выбора',
  retryLoadingMessagesAria: 'Повторить загрузку сообщений',
  retry: 'Повторить',

  reactionsGroupAria: 'Реакции',
  chooseReactionAria: 'Выбрать реакцию',
  youReactedSuffix: ', вы отреагировали',

  replyToMessageAria: 'Ответить на сообщение',
  replyingToMessageAria: 'Ответ на сообщение',
  cancelReply: 'Отменить ответ',
  replyToLabel: 'Ответ {sender}',
  replyOriginalUnavailable: 'Исходное сообщение недоступно',

  composerPlaceholder: 'Введите сообщение…',
  messageInputAria: 'Поле ввода сообщения',
  sendMessageAria: 'Отправить сообщение',
  send: 'Отправить',
  messageEmpty: 'Сообщение пустое',
  sendingMessage: 'Отправка сообщения…',
  messageExceedsLimit: 'Сообщение превышает лимит символов',
  charactersRemaining: 'Осталось символов: {remaining}',
  retrySendingMessageAria: 'Повторить отправку сообщения',
  attachFilesAria: 'Прикрепить файлы',
  attachFilesTitle: 'Прикрепить файл',
  recordVoiceMessageAria: 'Записать голосовое',
  recordVoiceMessageTitle: 'Записать голосовое',
  stopRecordingAria: 'Остановить запись',
  cancelRecordingAria: 'Отменить запись',
  recordingLabel: 'Запись {duration}',
  voicePreviewLabel: 'Предпросмотр голосового',
  sendVoiceMessageAria: 'Отправить голосовое',
  discardVoiceMessageAria: 'Отменить голосовое',
  voiceSlideHint: 'Влево ◂ — зафиксировать · ▴ вверх — отмена',
  voiceReleaseToCancelHint: 'Отпустите для отмены',
  voiceBubbleGroupAria: 'Голосовое сообщение',
  voicePlayAria: 'Воспроизвести голосовое',
  voicePauseAria: 'Пауза',
  voiceSpeedAria: 'Скорость воспроизведения',
  voiceWaveformSeekAria: 'Волна — клик или стрелки для перемотки',
  voicePlaybackErrorAria: 'Ошибка воспроизведения голосового',

  chooseFilesToAttachAria: 'Выбрать файлы для прикрепления',
  attachmentTrayAria: 'Вложения для отправки',
  cancelUploadOfAria: 'Отменить загрузку {name}',
  uploadingProgressAria: 'Загрузка…',
  announceUploadingFile: 'Загрузка {name}',
  announceFileUploaded: 'Загружено: {name}',
  announceUploadFailedFile: 'Ошибка загрузки: {name}',
  uploadFailed: 'Ошибка загрузки',
  queueUploadingCount: 'загружается: {n}',
  queueDoneCount: 'готово: {n}',
  queueFailedCount: 'ошибок: {n}',

  attachmentUnavailableAria: 'Вложение: {name} (недоступно)',
  imageAria: 'Изображение: {name}, {size}',
  audioAria: 'Аудио: {name}, {size}',
  fileAria: 'Файл: {name}, {size}',
  productViewAria: 'Открыть товар: {title}',
  productCardAttached: 'Карточка товара: {title}',
  removeProductCard: 'Убрать карточку товара',

  sessionExpired: 'Сессия истекла.',
  refresh: 'Обновить',
  refreshSessionAria: 'Обновить сессию',
  connectionLostReconnecting: 'Соединение потеряно. Переподключение… (попытка {n})',
  connected: 'Подключено.',
  couldNotReconnect: 'Не удалось переподключиться.',
  reconnect: 'Переподключиться',
  retryConnectionManuallyAria: 'Повторить подключение вручную',

  chatLoading: 'Загрузка чата…',

  roleBadgeModerator: 'модератор',
  roleBadgeOwner: 'владелец',
  typingOneUser: '{user} печатает…',
  typingTwoUsers: '{user1} и {user2} печатают…',
  typingMultiple: '{user1}, {user2} и ещё {n} печатают…',
  typingAriaLabel: 'Печатают: {names}',
  presenceOnline: 'В сети',
  presenceLastSeen: 'был(а) {time}',
  presenceLastSeenAria: '{name} был(а) {time}',
  readReceiptSent: 'Отправлено',
  readReceiptDelivered: 'Доставлено',
  readReceiptRead: 'Прочитано',
  readReceiptReadBy: 'Прочитано {n}',
  readReceiptAria: 'Статус сообщения: {status}',
  emojiPickerAria: 'Выбор эмодзи',
  emojiPickerSearch: 'Поиск эмодзи…',
  emojiPickerSearchAria: 'Поиск эмодзи',
  emojiPickerNoResults: 'Эмодзи не найдены',
  emojiPickerBtnAria: 'Открыть выбор эмодзи',
  threadTitle: 'Тред',
  threadReplies: '{n} ответов',
  threadReplyCount: '{n} ответ',
  threadCloseAria: 'Закрыть тред',
  threadSendReply: 'Отправить ответ',
  threadReplyPlaceholder: 'Ответить в тред…',
  threadLoading: 'Загрузка треда…',
  threadEmpty: 'Пока нет ответов',
  threadError: 'Не удалось загрузить тред',

  pinnedBannerTitle: 'Закреплённое сообщение',
  pinnedBannerPinnedBy: 'Закрепил(а) {name}',
  pinnedBannerNotLoaded: 'Закреплённое сообщение не загружено',
  pinnedBannerCloseAria: 'Закрыть баннер закреплённых',
  pinnedBannerPrevAria: 'Предыдущее закреплённое',
  pinnedBannerNextAria: 'Следующее закреплённое',
  pinnedBannerJumpAria: 'Перейти к сообщению',
  pinMessageAria: 'Закрепить сообщение',
  unpinMessageAria: 'Открепить сообщение',
};

const LOCALES: Record<Locale, LocaleTable> = { en, ru };

/**
 * Look up `key` in `table`, falling back to `fallback`'s value, then to the
 * raw key itself as an absolute last resort. Exported standalone (rather than
 * inlined in `t()`) so the fallback CHAIN is unit-testable against fixture
 * tables, independent of the production locale data — which, by design, is
 * always fully translated (so the "missing key" branch is otherwise
 * unreachable with real keys until a future key ships ahead of its
 * translation).
 */
export function lookupWithFallback(
  table: Partial<Record<string, string>>,
  fallback: Partial<Record<string, string>>,
  key: string,
): string {
  return table[key] ?? fallback[key] ?? key;
}

/**
 * Resolve a BCP-47 language tag (the `lang` constructor/attribute option, or
 * `undefined` when not set) to a supported `Locale`.
 *
 * Chain: explicit `lang` → `navigator.language` prefix → `'en'`. Only the
 * primary subtag is matched (`ru-RU` → `ru`), and any tag we don't ship a
 * translation for collapses to `en` — never throws, never returns undefined.
 */
export function resolveLocale(lang?: string | null): Locale {
  const raw = lang ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
  const prefix = raw?.split('-')[0]?.toLowerCase();
  return prefix === 'ru' ? 'ru' : 'en';
}

/**
 * Translate `key` for `lang`, substituting `{name}` placeholders from `params`.
 * Falls back to `en` for a key missing from `lang`'s table (see
 * `lookupWithFallback`); a `lang` outside `SUPPORTED_LOCALES` (reachable only
 * via a type-unsafe cast, since `Locale` is a closed union) falls back to
 * `en`'s table entirely.
 */
export function t(
  key: LocaleKey,
  lang: Locale,
  params?: Record<string, string | number>,
): string {
  const table = LOCALES[lang] ?? LOCALES.en;
  const template = lookupWithFallback(table, LOCALES.en, key);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
