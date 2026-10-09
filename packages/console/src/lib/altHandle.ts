// The altitude grabber's glyph: an upward chevron on a stub, offset above the
// marker it belongs to. Inline as a data URI rather than a file, because the hub
// serves this console off a Raspberry Pi over field WiFi and an overlay that
// fetches an icon is an overlay that can fail to draw.
//
// Shared by the mission and rally layers so the same gesture looks the same
// wherever it appears.

function encode(svg: string): string {
	if (typeof btoa === "function") return btoa(svg);
	// A stray import during a build or a test must not throw on a missing btoa.
	return Buffer.from(svg, "binary").toString("base64");
}

/** Pixels the handle rides above its marker (billboard pixelOffset Y). */
export const ALT_HANDLE_OFFSET_PX = -26;

/** On-screen size of the handle, in pixels. */
export const ALT_HANDLE_PX = 13;

export function altHandleImage(fill: string): string {
	return "data:image/svg+xml;base64," + encode(
		`<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">` +
		`<path d="M13 3 L22 13 L15.5 13 L15.5 23 L10.5 23 L10.5 13 L4 13 Z" ` +
		`fill="${fill}" stroke="#000" stroke-width="1.5"/></svg>`,
	);
}

/** Waypoint altitude handle (aqua, matching the mission layer's grabbers). */
export const ALT_HANDLE_MISSION = altHandleImage("#22d3ee");

/** Rally altitude handle (cyan, matching the rally markers). */
export const ALT_HANDLE_RALLY = altHandleImage("#67e8f9");
