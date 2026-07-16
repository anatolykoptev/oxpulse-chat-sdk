/**
 * @oxpulse/chat-widget — Shared floating-element positioning utility.
 *
 * Deduplicated from EmojiPicker.#position() and ReactionQuickBar.#position()
 * — both implemented the same isMountedOutside → fixed-vs-absolute +
 * viewport-clamp logic. This single function serves both.
 *
 * Coordinate frames:
 *   - mountedOutside=true  → position:fixed, viewport-relative coords
 *     (getBoundingClientRect returns viewport coords; fixed maps 1:1)
 *   - mountedOutside=false → position:absolute, container-relative coords
 *     (subtract containerRect to convert viewport → container-local)
 *
 * Viewport clamping keeps the floating element fully on-screen.
 */

export interface FloatingPositionArgs {
  /** Anchor element rect in viewport coords (getBoundingClientRect). */
  anchorRect: { top: number; bottom: number; left: number; right: number };
  /** Floating element dimensions (offsetWidth/offsetHeight). */
  elemWidth: number;
  elemHeight: number;
  /** True when the element is appended outside its constructor container
   *  (e.g. to a shadow root host) — selects fixed vs absolute. */
  mountedOutside: boolean;
  /** Container rect in viewport coords (only used when mountedOutside=false). */
  containerRect?: { top: number; left: number; width: number; height: number };
  /** Viewport dimensions. */
  viewportWidth: number;
  viewportHeight: number;
  /** Margin from viewport edges (px). Default 8. */
  margin?: number;
  /** Vertical placement preference. Default false (below anchor if room, above otherwise).
   *  Pass true to prefer above (ReactionQuickBar pattern). */
  preferAbove?: boolean;
  /** Gap between anchor and floating element (px). Default 4. */
  gap?: number;
  /** Anchor by right edge instead of left (own-message pattern). Default false. */
  anchorRight?: boolean;
}

export interface FloatingPositionResult {
  /** CSS position value: fixed or absolute. */
  position: 'fixed' | 'absolute';
  /** CSS top in px (coordinate-frame appropriate — viewport for fixed, container for absolute). */
  top: number;
  /** CSS left in px (set when anchoring by left edge). */
  left?: number;
  /** CSS right in px (set when anchoring by right edge — measured from
   *  containing block right edge, NOT viewport right). */
  right?: number;
  /** Vertical placement relative to anchor. */
  placement: 'above' | 'below';
}

/**
 * Compute the CSS position/top/left/right for a floating element anchored
 * to another element. Handles fixed-vs-absolute coordinate frames and
 * viewport clamping.
 *
 * For anchorRight=true (own-message pattern), returns `right` (distance
 * from containing block right edge) instead of `left`. The caller sets
 * `el.style.right = result.right + px` and must NOT set `left`.
 */
export function computeFloatingPosition(args: FloatingPositionArgs): FloatingPositionResult {
  const margin = args.margin ?? 8;
  const gap = args.gap ?? 4;
  const preferAbove = args.preferAbove ?? false;
  const anchorRight = args.anchorRight ?? false;
  const { anchorRect, elemWidth, elemHeight, mountedOutside, viewportWidth, viewportHeight } = args;

  const containerRect = args.containerRect ?? { top: 0, left: 0, width: viewportWidth, height: viewportHeight };
  const anchorTop = mountedOutside ? anchorRect.top : anchorRect.top - containerRect.top;
  const anchorBottom = mountedOutside ? anchorRect.bottom : anchorRect.bottom - containerRect.top;
  const anchorLeft = mountedOutside ? anchorRect.left : anchorRect.left - containerRect.left;
  const anchorRightEdge = mountedOutside ? anchorRect.right : anchorRect.right - containerRect.left;

  // Vertical: prefer above if requested and room, else below.
  // A degenerate containerRect.height (0 — e.g. a not-yet-laid-out container, or
  // jsdom which has no layout engine) must fall back to viewportHeight, matching
  // the pre-dedup EmojiPicker/ReactionQuickBar `offsetHeight || viewportHeight`
  // logic. Without this, the `Math.min(rawTop, containerHeight - elemHeight -
  // margin)` clamp below collapses a below-flip to `margin`, mis-placing the bar.
  const containerHeight = mountedOutside ? viewportHeight : (containerRect.height || viewportHeight);
  const spaceAbove = anchorTop;
  const wantAbove = preferAbove && spaceAbove >= elemHeight + gap;
  const placement: 'above' | 'below' = wantAbove ? 'above' : 'below';
  const rawTop = wantAbove
    ? anchorTop - elemHeight - gap
    : anchorBottom + gap;

  // Clamp top to keep element in viewport/container.
  const top = Math.max(margin, Math.min(rawTop, containerHeight - elemHeight - margin));

  // Horizontal.
  const containerWidth = mountedOutside ? viewportWidth : containerRect.width;

  if (anchorRight) {
    // Right-edge anchoring: bar hugs the bubble right side.
    // CSS `right` is measured from the containing block right edge.
    const cssRight = containerWidth - anchorRightEdge;
    const right = Math.max(margin, Math.min(cssRight, containerWidth - elemWidth - margin));
    return { position: mountedOutside ? 'fixed' : 'absolute', top, right, placement };
  }

  // Left-edge anchoring: align with anchor left edge.
  const rawLeft = anchorLeft;
  const left = Math.max(margin, Math.min(rawLeft, containerWidth - elemWidth - margin));
  return { position: mountedOutside ? 'fixed' : 'absolute', top, left, placement };
}
