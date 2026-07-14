// Six-emoji shortlist — Telegram-flavored set, broad emotional
// coverage in a row that fits the popover at 36px each. Frozen
// here so the page + tests share one source of truth.
// Ported verbatim from web/src/lib/chat/reactions/reaction-types.ts.
import { t, type Locale } from './i18n.js';

export const REACTION_EMOJIS = [
	"\u{1F44D}",  // 👍
	"❤️", // ❤️
	"\u{1F602}",  // 😂
	"\u{1F389}",  // 🎉
	"\u{1F622}",  // 😢
	"\u{1F525}",  // 🔥
] as const;

/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

/** Heart-first affordance (spec amendment 2026-07-14): the per-bubble heart
 *  button always targets this one emoji — single source of truth so its
 *  string literal never drifts from REACTION_EMOJIS[1]. */
export const HEART_EMOJI: ReactionEmoji = REACTION_EMOJIS[1];

/** Stable, localized `aria-label` per emoji — keeps screen-reader output
 *  predictable and out of the visual noise. Keyed by emoji (not a `t()`
 *  LocaleKey) — this is domain data (which word names which emoji), a
 *  different shape than the widget's flat UI-string table in ./i18n.ts. */
const REACTION_ARIA_LABEL: Record<Locale, Record<string, string>> = {
	en: {
		"\u{1F44D}": "React with thumbs up",
		"❤️": "React with heart",
		"\u{1F602}": "React with laughing",
		"\u{1F389}": "React with party popper",
		"\u{1F622}": "React with crying",
		"\u{1F525}": "React with fire",
	},
	ru: {
		"\u{1F44D}": "Реакция «палец вверх»",
		"❤️": "Реакция «сердце»",
		"\u{1F602}": "Реакция «смех»",
		"\u{1F389}": "Реакция «хлопушка»",
		"\u{1F622}": "Реакция «слёзы»",
		"\u{1F525}": "Реакция «огонь»",
	},
};
const REACTION_ARIA_FALLBACK: Record<Locale, string> = {
	en: "React with emoji",
	ru: "Реакция «эмодзи»",
};

/** `lang` defaults to 'en' so every existing call site (incl. direct-import
 *  unit tests) keeps working without a signature change. */
export function reactionAriaLabel(emoji: string, lang: Locale = 'en'): string {
	const table = REACTION_ARIA_LABEL[lang] ?? REACTION_ARIA_LABEL.en;
	return table[emoji] ?? REACTION_ARIA_LABEL.en[emoji] ?? REACTION_ARIA_FALLBACK[lang] ?? REACTION_ARIA_FALLBACK.en;
}

/** Russian has 3 plural forms (1 / 2-4 / 5+, with the usual 11-14 exception);
 *  English has 2. Used only for the reaction-count aria composition below —
 *  not exposed via the flat `t()` table since plural RULES (not just
 *  strings) differ per locale. */
const REACTION_COUNT_WORDS: Record<Locale, readonly [string, string, string]> = {
	en: ["reaction", "reactions", "reactions"],
	ru: ["реакция", "реакции", "реакций"],
};

function reactionCountWord(n: number, lang: Locale): string {
	const forms = REACTION_COUNT_WORDS[lang] ?? REACTION_COUNT_WORDS.en;
	if (lang === 'ru') {
		const mod10 = n % 10;
		const mod100 = n % 100;
		if (mod10 === 1 && mod100 !== 11) return forms[0];
		if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
		return forms[2];
	}
	return n === 1 ? forms[0] : forms[1];
}

/** Full aria-label for a reaction chip button: emoji name + count + an
 *  optional "you reacted" suffix. Was inlined as string concatenation in
 *  message-list.ts (`${reactionAriaLabel(emoji)}, ${count} reaction${count
 *  !== 1 ? 's' : ''}${isOwn ? ', you reacted' : ''}`) — moved here so the
 *  RU pluralization rule lives next to the emoji-name table it composes with. */
export function reactionButtonAriaLabel(
	emoji: string,
	count: number,
	isOwn: boolean,
	lang: Locale = 'en',
): string {
	const base = reactionAriaLabel(emoji, lang);
	const suffix = isOwn ? t('youReactedSuffix', lang) : '';
	return `${base}, ${count} ${reactionCountWord(count, lang)}${suffix}`;
}

/** Lookup: does the caller's `ownReactions` set contain this emoji?
 *  Pure so the chip-highlight logic is unit-testable without
 *  mounting the component. */
export function isOwnReaction(
	emoji: string,
	ownReactions: ReadonlyArray<string> | undefined,
): boolean {
	if (!ownReactions || ownReactions.length === 0) return false;
	for (const e of ownReactions) if (e === emoji) return true;
	return false;
}
