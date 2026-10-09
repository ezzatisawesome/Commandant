"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";

import { $hudFrame } from "@/stores/aircraft.store";
import { $derived } from "@/stores/derived.store";
import { $linkState } from "@/stores/link.store";
import { isNum } from "@/lib/flightGeometry";
import {
	headingTicks, ladderRungs, horizonOffsetPx, tapeTicks, flightPathOffset,
	wrap360, BANK_TICKS, bankMajor, type HudGeometry,
} from "@/lib/hud";

// A head-up display drawn over the globe: horizon, pitch ladder, bank scale,
// flight path marker, heading tape along the top, airspeed and altitude tapes
// down the sides.
//
// Fixed to the screen, not to the aircraft. The symbology stays still and the
// world moves behind it, which is how a real HUD works and what makes it
// readable at any camera angle or zoom. The boxed attitude and compass widgets
// this replaces were a picture of the aircraft; this is the view from it.
//
// All geometry comes from lib/hud.ts, which is pure and tested. Nothing here
// computes an angle, because a sign error in a HUD is read as truth.
//
// One SVG, pointer-events-none, so the whole thing is transparent to the mouse
// and the globe still drags and zooms underneath.

const STROKE = "rgba(126,255,166,0.92)";      // HUD green, the aviation default
const STROKE_DIM = "rgba(126,255,166,0.45)";
const FONT = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";

/** Degrees of pitch per pixel. 8 px/deg puts the 10 degree rung a comfortable
 *  80 px from the horizon on a laptop screen. */
const PX_PER_DEG = 8;

/** The tapes: step between ticks, labelled every, and pixels per unit. */
const SPEED_TAPE = { step: 1, labelEvery: 5, pxPerUnit: 9, halfPx: 92 };
const ALT_TAPE = { step: 2, labelEvery: 10, pxPerUnit: 4.5, halfPx: 92 };

export default function Hud() {
	const f = useStore($hudFrame);
	const d = useStore($derived);
	const linkState = useStore($linkState);
	const host = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });

	// The HUD is sized to the viewport, so it has to follow a resize. A
	// ResizeObserver rather than a window listener, because the globe container
	// is what actually changes.
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => {
			const r = entry.contentRect;
			setSize({ w: r.width, h: r.height });
		});
		ro.observe(el);
		setSize({ w: el.clientWidth, h: el.clientHeight });
		return () => ro.disconnect();
	}, []);

	const { w, h } = size;
	// Nothing to draw before the first measurement, and nothing to draw for a
	// link that is down: a HUD frozen at the last attitude is a lie, and the
	// aircraft symbol sitting level over a stale scene is exactly the failure
	// mode the stale badge exists to prevent.
	if (w === 0 || h === 0) {
		return <div ref={host} className="pointer-events-none fixed inset-0 z-30" />;
	}

	const cx = w / 2;
	const cy = h / 2;
	const geo: HudGeometry = { w: cx, h: cy, pxPerDeg: PX_PER_DEG };

	const dead = linkState !== "alive" || !f?.connected;
	const rollDeg = isNum(f?.roll) ? (f!.roll * 180) / Math.PI : null;
	const pitchDeg = isNum(f?.pitch) ? (f!.pitch * 180) / Math.PI : null;
	const headingDeg = isNum(f?.yaw)
		? wrap360((f!.yaw * 180) / Math.PI)
		: (isNum(f?.heading) ? wrap360(f!.heading) : null);

	const attitudeKnown = rollDeg !== null && pitchDeg !== null && !dead;
	const horizonY = attitudeKnown ? horizonOffsetPx(pitchDeg!, geo) : 0;
	const rungs = attitudeKnown ? ladderRungs(pitchDeg!, geo) : [];

	const fpm = attitudeKnown
		? flightPathOffset(
			d.trackDeg, headingDeg,
			isNum(f?.climb) ? f!.climb : null,
			isNum(f?.groundspeed) ? f!.groundspeed : null,
			geo,
		)
		: null;

	// Airspeed where the vehicle reports it, groundspeed otherwise. Labelled so
	// the two are never confused: on a solar aircraft in wind they differ a lot.
	const speedIsAir = isNum(f?.airspeed) && f!.airspeed > 0;
	const speed: number | null = speedIsAir ? f!.airspeed!
		: (isNum(f?.groundspeed) ? f!.groundspeed : null);
	const alt = isNum(f?.alt) ? f!.alt : null;

	return (
		<div ref={host} className="pointer-events-none fixed inset-0 z-30">
			<svg width={w} height={h} className="block">
				{/* ---- centre group: horizon, ladder, and the bank scale ---- */}
				{attitudeKnown ? (
					<g transform={`translate(${cx} ${cy})`}>
						{/* Horizon and ladder bank with the aircraft. The ladder is
						    inside the rotation because a pitch reference that did not
						    rotate would read wrong in any turn. */}
						<g transform={`rotate(${-rollDeg!}) translate(0 ${horizonY})`}>
							{/* Horizon, with a gap at the centre for the aircraft symbol. */}
							<line x1={-cx * 0.92} y1={0} x2={-cx * 0.1} y2={0}
								stroke={STROKE} strokeWidth={1.5} />
							<line x1={cx * 0.1} y1={0} x2={cx * 0.92} y2={0}
								stroke={STROKE} strokeWidth={1.5} />

							{rungs.map((r) => (
								<g key={r.deg} transform={`translate(0 ${-r.offsetPx})`}>
									<line x1={-r.armPx} y1={0} x2={-r.armPx * 0.45} y2={0}
										stroke={STROKE} strokeWidth={1.2}
										strokeDasharray={r.dashed ? "6 4" : undefined} />
									<line x1={r.armPx * 0.45} y1={0} x2={r.armPx} y2={0}
										stroke={STROKE} strokeWidth={1.2}
										strokeDasharray={r.dashed ? "6 4" : undefined} />
									{/* Tick ends point toward the horizon, the standard cue
									    for which way is up when the ladder fills the screen. */}
									<line x1={-r.armPx} y1={0} x2={-r.armPx}
										y2={r.deg > 0 ? 6 : -6} stroke={STROKE} strokeWidth={1.2} />
									<line x1={r.armPx} y1={0} x2={r.armPx}
										y2={r.deg > 0 ? 6 : -6} stroke={STROKE} strokeWidth={1.2} />
									<text x={-r.armPx - 6} y={4} textAnchor="end"
										style={{ font: FONT }} fill={STROKE}>
										{Math.abs(r.deg)}
									</text>
									<text x={r.armPx + 6} y={4} style={{ font: FONT }} fill={STROKE}>
										{Math.abs(r.deg)}
									</text>
								</g>
							))}
						</g>

						{/* Bank scale: fixed arc, moving pointer. */}
						<g>
							{BANK_TICKS.map((deg) => {
								const rad = ((deg - 90) * Math.PI) / 180;
								const r0 = cy * 0.52;
								const r1 = r0 + (bankMajor(deg) ? 11 : 6);
								return (
									<line key={deg}
										x1={Math.cos(rad) * r0} y1={Math.sin(rad) * r0}
										x2={Math.cos(rad) * r1} y2={Math.sin(rad) * r1}
										stroke={bankMajor(deg) ? STROKE : STROKE_DIM}
										strokeWidth={bankMajor(deg) ? 1.6 : 1.1} />
								);
							})}
							{/* The pointer sits at the current bank, so level flight puts
							    it on the apex tick. */}
							<g transform={`rotate(${-rollDeg!})`}>
								<polygon
									points={`0,${-cy * 0.52 + 2} -6,${-cy * 0.52 + 13} 6,${-cy * 0.52 + 13}`}
									fill={STROKE} />
							</g>
						</g>

						{/* Aircraft reference: fixed wings and centre dot. Never moves —
						    it IS the aircraft, and everything else is read against it. */}
						<g stroke={STROKE} strokeWidth={2.2} fill="none">
							<line x1={-54} y1={0} x2={-20} y2={0} />
							<line x1={-20} y1={0} x2={-12} y2={7} />
							<line x1={54} y1={0} x2={20} y2={0} />
							<line x1={20} y1={0} x2={12} y2={7} />
						</g>
						<circle cx={0} cy={0} r={2} fill={STROKE} />

						{/* Flight path marker: where the aircraft is actually going. */}
						{fpm ? (
							<g transform={`translate(${fpm.x} ${fpm.y})`}
								stroke={STROKE} strokeWidth={1.6} fill="none">
								<circle cx={0} cy={0} r={7} />
								<line x1={-7} y1={0} x2={-15} y2={0} />
								<line x1={7} y1={0} x2={15} y2={0} />
								<line x1={0} y1={-7} x2={0} y2={-13} />
							</g>
						) : null}
					</g>
				) : (
					// No attitude: say so where the horizon would be, rather than
					// drawing a level horizon the operator would believe.
					<text x={cx} y={cy} textAnchor="middle" style={{ font: FONT }}
						fill="rgba(255,120,120,0.9)">
						{dead ? "NO LINK — ATTITUDE UNAVAILABLE" : "ATTITUDE UNAVAILABLE"}
					</text>
				)}

				{/* ---- heading tape, top centre ---- */}
				{headingDeg !== null && !dead ? (
					<g transform={`translate(${cx} 34)`}>
						<line x1={-cx * 0.42} y1={14} x2={cx * 0.42} y2={14}
							stroke={STROKE_DIM} strokeWidth={1} />
						{headingTicks(headingDeg).map((t) => {
							const x = t.offsetDeg * (cx * 0.42 / 40);
							return (
								<g key={`${t.deg}:${t.offsetDeg}`} transform={`translate(${x} 0)`}>
									<line x1={0} y1={t.major ? 4 : 9} x2={0} y2={14}
										stroke={t.major ? STROKE : STROKE_DIM}
										strokeWidth={t.major ? 1.5 : 1} />
									{t.label ? (
										<text x={0} y={-2} textAnchor="middle"
											style={{ font: FONT }} fill={STROKE}>
											{t.label}
										</text>
									) : null}
								</g>
							);
						})}
						{/* Pointer and the exact heading, because reading a tape to the
						    degree is slower than reading three digits. */}
						<polygon points="0,16 -6,26 6,26" fill={STROKE} />
						<text x={0} y={39} textAnchor="middle" style={{ font: FONT }} fill={STROKE}>
							{String(Math.round(headingDeg) % 360).padStart(3, "0")}
						</text>
					</g>
				) : null}

				{/* ---- airspeed tape, left ---- */}
				<Tape
					x={64} cy={cy} value={dead ? null : speed} spec={SPEED_TAPE}
					side="left" digits={1}
					caption={speedIsAir ? "m/s IAS" : "m/s GS"}
				/>

				{/* ---- altitude tape, right ----
				    Inboard of 64 px, unlike the speed tape: the dock occupies the
				    right edge at the vertical centre, which is exactly this tape's
				    height band. */}
				<Tape
					x={w - 112} cy={cy} value={dead ? null : alt} spec={ALT_TAPE}
					side="right" digits={0}
					caption="m MSL"
					// AGL under the altitude tape: the number that decides whether the
					// aircraft clears the hill, which MSL alone does not answer.
					sub={d.aglM !== null ? `${d.aglM.toFixed(0)} AGL` : undefined}
					subTone={d.clearance === "critical" ? "rgba(255,110,110,0.95)"
						: d.clearance === "low" ? "rgba(255,190,110,0.95)" : STROKE_DIM}
				/>
			</svg>
		</div>
	);
}

interface TapeSpec { step: number; labelEvery: number; pxPerUnit: number; halfPx: number }

/** One vertical tape: ticks scrolling against a fixed boxed readout. */
function Tape({
	x, cy, value, spec, side, digits, caption, sub, subTone,
}: {
	x: number; cy: number; value: number | null; spec: TapeSpec;
	side: "left" | "right"; digits: number; caption: string;
	sub?: string; subTone?: string;
}) {
	const ticks = value === null ? [] : tapeTicks(
		value, spec.step, spec.labelEvery, spec.pxPerUnit, spec.halfPx,
	);
	const dir = side === "left" ? -1 : 1;     // which way the ticks point
	return (
		<g transform={`translate(${x} ${cy})`}>
			{/* The spine. Drawn even with no value, so the HUD keeps its shape
			    rather than collapsing when a field goes missing. */}
			<line x1={0} y1={-spec.halfPx} x2={0} y2={spec.halfPx}
				stroke={STROKE_DIM} strokeWidth={1} />
			{ticks.map((t) => (
				<g key={t.value} transform={`translate(0 ${t.offsetPx})`}>
					<line x1={0} y1={0} x2={dir * (t.major ? 10 : 5)} y2={0}
						stroke={t.major ? STROKE : STROKE_DIM}
						strokeWidth={t.major ? 1.4 : 1} />
					{t.label ? (
						<text x={dir * 14} y={4}
							textAnchor={side === "left" ? "end" : "start"}
							style={{ font: FONT }} fill={STROKE}>
							{t.label}
						</text>
					) : null}
				</g>
			))}
			{/* Boxed current value at the pointer. */}
			<g>
				<polygon
					points={`${dir * 2},0 ${dir * 10},-8 ${dir * 58},-8 ${dir * 58},8 ${dir * 10},8`}
					fill="rgba(0,0,0,0.55)" stroke={STROKE} strokeWidth={1.3} />
				<text x={dir * 34} y={4} textAnchor="middle" style={{ font: FONT }} fill={STROKE}>
					{value === null ? "---" : value.toFixed(digits)}
				</text>
			</g>
			<text x={0} y={spec.halfPx + 16} textAnchor="middle"
				style={{ font: FONT }} fill={STROKE_DIM}>
				{caption}
			</text>
			{sub ? (
				<text x={0} y={spec.halfPx + 31} textAnchor="middle"
					style={{ font: FONT }} fill={subTone ?? STROKE_DIM}>
					{sub}
				</text>
			) : null}
		</g>
	);
}
