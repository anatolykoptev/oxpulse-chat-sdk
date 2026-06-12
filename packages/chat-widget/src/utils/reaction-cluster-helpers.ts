// Pure helpers — exported so the empty/sort/highlight logic is
// unit-testable without mounting Svelte.
// Ported verbatim from web/src/lib/chat/reactions/reaction-cluster-helpers.ts.

export type ReactionTuple = readonly [string, ReadonlyArray<string>];

export function shouldRenderCluster(
	reactions: ReadonlyArray<ReactionTuple>,
): boolean {
	return reactions.length > 0;
}

/** True iff `selfPeerId` appears in this emoji's peer list — drives
 *  the brand-primary ring + own-chip background. */
export function isOwnChip(
	tuple: ReactionTuple,
	selfPeerId: string,
): boolean {
	const [, peers] = tuple;
	for (let i = 0; i < peers.length; i++) {
		if (peers[i] === selfPeerId) return true;
	}
	return false;
}

export function chipLabel(tuple: ReactionTuple): string {
	const [emoji, peers] = tuple;
	return `${emoji} ${peers.length}`;
}
