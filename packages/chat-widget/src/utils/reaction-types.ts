// Six-emoji shortlist — Telegram-flavored set, broad emotional
// coverage in a row that fits the popover at 36px each. Frozen
// here so the page + tests share one source of truth.
// Ported verbatim from web/src/lib/chat/reactions/reaction-types.ts.
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

/** Stable `aria-label` per emoji — keeps screen-reader output
 *  predictable and out of the visual noise. */
const EMOJI_LABEL: Record<string, string> = {
	"\u{1F44D}": "thumbs up",
	"❤️": "heart",
	"\u{1F602}": "laughing",
	"\u{1F389}": "party popper",
	"\u{1F622}": "crying",
	"\u{1F525}": "fire",
};

export function reactionAriaLabel(emoji: string): string {
	const word = EMOJI_LABEL[emoji] ?? "emoji";
	return `React with ${word}`;
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
