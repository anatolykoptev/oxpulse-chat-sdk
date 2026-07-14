// computeQuickBarPosition — pure above/below flip + own-message right-anchor
// decision for the ReactionQuickBar. Ported (reuse-update 2026-07-14) from
// oxpulse-chat web's
// web/src/lib/chat/reactions/message-actions-helpers.ts::computePopoverPosition
// (same algorithm: above-preferred, matches Telegram/iMessage; flip below
// when there's not enough room above the anchor inside the viewport; own
// messages anchor by right edge so the bar hugs the bubble's right side).
//
// This decides ONLY placement + left-vs-right anchor edge. The bar's own
// left/right viewport-width clamp (F2/4C/DM3, ReactionQuickBar#position) is
// a separate, pre-existing concern layered on top of this decision — not
// ported here, since web has no equivalent (its popover doesn't clamp to a
// narrow-viewport right edge the way the shadow-host-escaping bar does).

export interface QuickBarPositionArgs {
	readonly anchorRect: { top: number; bottom: number; left: number; right: number };
	readonly barHeight: number;
	/** Top edge of the visible viewport, in the SAME coordinate frame as
	 *  anchorRect — pass 0 when anchorRect is already viewport-relative
	 *  (position:fixed / shadow-host mount) or when the containing block
	 *  doesn't scroll independently (position:absolute inside a
	 *  non-scrolling wrapper — ReactionQuickBar's #container case). */
	readonly viewportTop: number;
	readonly isOwn: boolean;
	readonly gap?: number;
}

export interface QuickBarPosition {
	readonly top: number;
	readonly placement: 'above' | 'below';
	/** Set for a non-own message (anchor by left edge). Undefined when `right` is set. */
	readonly left?: number;
	/** Set for an own message (anchor by right edge, bar hugs the bubble's right side). Undefined when `left` is set. */
	readonly right?: number;
}

export function computeQuickBarPosition(args: QuickBarPositionArgs): QuickBarPosition {
	const gap = args.gap ?? 8;
	const wantAbove = args.anchorRect.top - args.viewportTop >= args.barHeight + gap;
	const placement: 'above' | 'below' = wantAbove ? 'above' : 'below';
	const top = wantAbove
		? args.anchorRect.top - args.barHeight - gap
		: args.anchorRect.bottom + gap;

	if (args.isOwn) {
		return { top, right: args.anchorRect.right, placement };
	}
	return { top, left: args.anchorRect.left, placement };
}
