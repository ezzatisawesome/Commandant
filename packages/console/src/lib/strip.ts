// Pure helpers for the telemetry strip's cells.
//
// The strip divides the row evenly between however many channels the operator
// put in it, so a cell's width has nothing to do with the length of its
// contents: "GLOBAL_POSITION_INT" or a six-digit reading gets the same slice as
// "ALT". Truncation is the right behaviour for the resting state — a ragged row
// of different widths is harder to scan than a tidy one — but a value you
// cannot read is not telemetry, so the full text has to be recoverable. These
// two decide what to show and when, away from the DOM, so both are testable.

/** Cell contents, as much of it as the hover text needs. */
export interface HoverableCell {
	label: string;
	value: string;
	unit?: string;
	title?: string;
}

/**
 * The full, untruncated text for a cell — the native tooltip, and the body of
 * the hover bubble.
 *
 * The label is included even though it is right there on screen, because it is
 * truncated by the same slice the value is: "GLOBAL_POSITION…" is exactly the
 * case where you need the tooltip, and a tooltip that repeats the clipped half
 * and omits the rest helps nobody.
 */
export function cellHoverText(view: HoverableCell): string {
	const head = `${view.label}: ${view.value}${view.unit ? ` ${view.unit}` : ""}`;
	return view.title ? `${head} — ${view.title}` : head;
}

/**
 * Is this element's text actually cut off?
 *
 * Takes the two measurements rather than the element, so it can be tested
 * without a layout engine. The 1 px tolerance is deliberate: sub-pixel text
 * metrics make `scrollWidth` exceed `clientWidth` by a fraction on text that is
 * fully visible, and a bubble that appears over an uncut cell is noise.
 */
export function isClipped(
	el: { scrollWidth: number; clientWidth: number } | null | undefined,
): boolean {
	return !!el && el.scrollWidth > el.clientWidth + 1;
}
