"use client";

import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";

import { $statusTexts } from "@/stores/statustext.store";
import { logFeedBox, logFeedFit, LOG_FEED_LEFT, LOG_FEED_TOP } from "@/lib/hud";

// The live autopilot feed, top-left under the wordmark: the last few STATUSTEXT
// lines in green mono, like a console tailing a log.
//
// Why here and not in the dock: the dock's Status panel was a click away from
// something the screen can simply show, and a scroll icon in the gutter is a
// worse answer than legible text in the corner. So this is the whole log
// surface now — deeper and larger than the old eight-line hint, but still
// pointer-events-none and still bounded, so it cannot grow into a panel or take
// a click away from the globe.
//
// Severity still wins over the green. An EKF failure or a failsafe reason
// rendered in the same calm green as "mission accepted" would hide exactly the
// line the operator needs, so warnings stay amber and errors stay red; green is
// the resting colour for notice/info traffic.

// The tail is now the only log surface on screen — the dock's Status panel is
// gone, and with it the one place that showed more than a handful of lines. So
// it runs deeper and reads larger: 12px mono instead of 10, semibold, and
// sixteen lines rather than eight. Still bounded, still pointer-events-none,
// so it cannot grow into a panel.
const TAIL = 16;

// ...up to a point. The tail is bounded by the SPACE it has, not only by a line
// count: sixteen lines is 320 px, and on a 760 px window the feed reached the
// airspeed tape and drew over it. A log line is replaceable -- the next one is
// along in a second, and the whole history is in the flight log -- while the
// airspeed readout is not, so the log is what yields. lib/hud.ts owns the box
// and the fit, with the rest of the HUD's geometry, and a test asserts the two
// never share a pixel.

function sevClass(sev: number): string {
	if (sev <= 3) return "text-red-400";
	if (sev === 4) return "text-amber-300";
	return "text-emerald-400";
}

const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

export function LogFeed() {
	const entries = useStore($statusTexts);
	// The box depends on the viewport, so the feed has to follow a resize. A
	// window listener rather than a ResizeObserver: this instrument is positioned
	// against the window itself, not against a container.
	const [vp, setVp] = useState<{ w: number; h: number } | null>(null);
	useEffect(() => {
		const read = () => setVp({ w: window.innerWidth, h: window.innerHeight });
		read();
		window.addEventListener("resize", read);
		return () => window.removeEventListener("resize", read);
	}, []);

	const recent = entries.slice(-TAIL);
	const box = vp ? logFeedBox(vp.w, vp.h) : null;
	// Slice from the END, so what gets dropped is the oldest line and the newest
	// is always on screen. Before the first measurement there is nothing to show
	// anyway — status text only arrives over the socket, which is client-side.
	const shown = box ? recent.slice(-logFeedFit(recent.map((e) => e.text), box)) : [];
	if (shown.length === 0) return null;

	return (
		<div
			aria-live="polite"
			style={{
				left: box ? box.x0 : LOG_FEED_LEFT,
				// The top is not always under the wordmark: on a narrow window the
				// feed drops below the heading tape instead of running under it.
				top: box ? box.y0 : LOG_FEED_TOP,
				// A hard stop as well as the computed fit. The fit assumes a
				// monospace advance width; a glyph that is not in the mono face
				// falls back to a proportional one and can be wider, and a
				// mis-estimate must still not reach the tape.
				maxWidth: box ? box.x1 - box.x0 : undefined,
				maxHeight: box ? box.y1 - box.y0 : undefined,
			}}
			className="pointer-events-none fixed z-40 overflow-hidden
				font-mono text-[12px] font-semibold leading-relaxed tracking-tight"
		>
			{shown.map((e, i) => (
				<div
					key={e.id}
					// Oldest lines fade, so the newest line is the one the eye lands on.
					// A deeper tail needs a shallower fade, or the oldest of sixteen
					// lines is unreadable rather than merely quieter.
					style={{ opacity: 0.55 + (0.45 * (i + 1)) / shown.length }}
					className="flex gap-1.5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
				>
					<span className="shrink-0 text-emerald-400/60">{hhmmss(e.t)}</span>
					<span className={`${sevClass(e.severity)} break-words`}>{e.text}</span>
				</div>
			))}
		</div>
	);
}

export default LogFeed;
