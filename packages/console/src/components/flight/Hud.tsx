"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";

import { $hudFrame } from "@/stores/aircraft.store";
import { $derived } from "@/stores/derived.store";
import { $linkState } from "@/stores/link.store";
import { isNum } from "@/lib/flightGeometry";
import {
	headingTicks, tapeTicks, wrap360, ballPitchMarks, BALL_BANK_TICKS,
	bankMajor, rollLabel, pitchLabel, quantize, HUD_STEP,
	ballCentre, BALL_LABEL_DROP,
} from "@/lib/hud";

// Flight instruments drawn over the globe: airspeed and altitude tapes down the
// sides, a heading tape across the top, and a compact attitude ball in the
// top-right corner.
//
// There WAS a full cockpit HUD here — a screen-height pitch ladder, horizon and
// flight path marker through the centre. It went because the metaphor was wrong
// for this application. A cockpit HUD exists because the pilot cannot see their
// own aircraft; here the operator is looking at the aircraft from outside, on a
// globe, and the 3D model already banks and pitches in front of them. So the
// ladder was spending the most valuable part of the screen to restate what the
// scene showed, which is exactly the trade this layout is supposed to refuse.
//
// What survived is what the globe genuinely cannot say: how fast, how high, how
// much air is underneath, which way round, and precise attitude in degrees. The
// tapes live at the edges and the ball is 92 px in a corner the globe was not
// using.
//
// The ball sits TOP-RIGHT. It was bottom-left, which put it in the corner a
// camera tilted toward the horizon fills with sky and foreground terrain, and
// directly above the telemetry strip it had to be nudged clear of. Top-right is
// the quietest corner on the page: the wordmark owns top-left, the alerts stack
// top-centre, the heading tape stops at 0.71 w, and the dock is pinned to the
// vertical centre of the right edge rather than its top. lib/hud.ts holds the
// boxes and a test asserts they do not collide.
//
// All geometry comes from lib/hud.ts, which is pure and tested. Nothing here
// computes an angle, because a sign error in an instrument is read as truth.
//
// Every input is quantised to the precision its instrument can show, and each
// instrument is memoised on those quantised values. Without that, a float whose
// last bits change every tick defeats every memo and the whole SVG is diffed ten
// times a second: measured at 8.4 ms per frame with the CPU throttled 4x, which
// is this console's real situation beside a SITL simulator. See lib/hud.ts.
//
// One SVG, pointer-events-none, so the whole thing is transparent to the mouse
// and the globe still drags and zooms underneath.

const STROKE = "rgba(126,255,166,0.92)";      // HUD green, the aviation default
const STROKE_DIM = "rgba(126,255,166,0.45)";  // minor ticks and spines only
// Unit captions under each tape. These were STROKE_DIM, which is right for a
// tick mark and wrong for text: a 12 px glyph at 45 % alpha over bright terrain
// is genuinely unreadable, and the caption is what says whether the tape is
// airspeed or groundspeed — the one distinction on a solar aircraft in wind that
// must never be guessed at.
const STROKE_UNIT = "rgba(150,255,180,0.95)";
const FONT = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";

/** Attitude ball: radius, and degrees of pitch per pixel inside it. 1.7 px/deg
 *  fits +-30 degrees of pitch either side of the horizon inside the disc. */
const BALL_R = 46;
const BALL_PX_PER_DEG = 1.2;
// Where the ball goes is in lib/hud.ts (ballCentre / ballBox), with the rest of
// the HUD's geometry — a corner that is clear at 1440 px need not be at 900, and
// two instruments over the same pixels fail silently.

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

	const dead = linkState !== "alive" || !f?.connected;
	const rollDeg = quantize(isNum(f?.roll) ? (f!.roll * 180) / Math.PI : null,
		HUD_STEP.attitudeDeg);
	const pitchDeg = quantize(isNum(f?.pitch) ? (f!.pitch * 180) / Math.PI : null,
		HUD_STEP.attitudeDeg);
	const headingDeg = quantize(
		isNum(f?.yaw) ? wrap360((f!.yaw * 180) / Math.PI)
			: (isNum(f?.heading) ? wrap360(f!.heading) : null),
		HUD_STEP.headingDeg);

	const attitudeKnown = rollDeg !== null && pitchDeg !== null && !dead;

	// Airspeed where the vehicle reports it, groundspeed otherwise. Labelled so
	// the two are never confused: on a solar aircraft in wind they differ a lot.
	const speedIsAir = isNum(f?.airspeed) && f!.airspeed > 0;
	const speed = quantize(speedIsAir ? f!.airspeed
		: (isNum(f?.groundspeed) ? f!.groundspeed : null), HUD_STEP.speedMps);
	const alt = quantize(isNum(f?.alt) ? f!.alt : null, HUD_STEP.altM);
	const aglM = quantize(d.aglM, HUD_STEP.aglM);

	return (
		<div ref={host} className="pointer-events-none fixed inset-0 z-30">
			<svg width={w} height={h} className="block">
				<HeadingTape cx={cx} deg={dead ? null : headingDeg} />

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
					sub={aglM !== null ? `${aglM.toFixed(0)} AGL` : undefined}
					subTone={d.clearance === "critical" ? "rgba(255,110,110,0.95)"
						: d.clearance === "low" ? "rgba(255,190,110,0.95)" : STROKE_UNIT}
				/>
				{/* ---- attitude ball, top right ---- */}
				<AttitudeBall
					{...ballCentre(w, h, BALL_R)}
					rollDeg={attitudeKnown ? rollDeg : null}
					pitchDeg={attitudeKnown ? pitchDeg : null}
				/>
			</svg>
		</div>
	);
}

/**
 * A 92 px attitude indicator: horizon, pitch scale, bank ticks and a fixed
 * aircraft reference, clipped to a disc.
 *
 * Same conventions as the tapes, so nothing has to be relearned between them:
 * the horizon rotates by minus the bank angle and moves DOWN as the nose comes
 * up, and the aircraft reference never moves.
 */
const AttitudeBall = memo(function AttitudeBall({
	cx, cy, rollDeg, pitchDeg,
}: { cx: number; cy: number; rollDeg: number | null; pitchDeg: number | null }) {
	const known = rollDeg !== null && pitchDeg !== null;
	const marks = known ? ballPitchMarks(pitchDeg!, BALL_R, BALL_PX_PER_DEG) : [];
	const clipId = "hud-ball-clip";
	return (
		<g transform={`translate(${cx} ${cy})`}>
			<defs>
				<clipPath id={clipId}>
					<circle cx={0} cy={0} r={BALL_R} />
				</clipPath>
			</defs>

			{/* A dark disc so the horizon reads against the globe rather than
			    disappearing into terrain of a similar colour. */}
			<circle cx={0} cy={0} r={BALL_R} fill="rgba(0,0,0,0.42)"
				stroke={STROKE_DIM} strokeWidth={1} />

			{known ? (
				// Horizon and pitch scale bank together. Both are positioned from
				// the ball centre with pitch already folded in by lib/hud.ts, so
				// this group only rotates.
				<g clipPath={`url(#${clipId})`} transform={`rotate(${-rollDeg!})`}>
					<line
						x1={-BALL_R} x2={BALL_R}
						y1={pitchDeg! * BALL_PX_PER_DEG} y2={pitchDeg! * BALL_PX_PER_DEG}
						stroke={STROKE} strokeWidth={1.6} />
					{marks.map((m) => (
						<line key={m.deg}
							x1={-m.armPx} x2={m.armPx}
							y1={m.offsetPx} y2={m.offsetPx}
							stroke={m.major ? STROKE : STROKE_DIM}
							strokeWidth={m.major ? 1.2 : 1}
							strokeDasharray={m.deg < 0 ? "3 3" : undefined} />
					))}
				</g>
			) : null}

			{/* Bank ticks on the rim: fixed scale, and the disc's contents rotate
			    against them. */}
			{BALL_BANK_TICKS.map((deg) => {
				const rad = ((deg - 90) * Math.PI) / 180;
				const r1 = BALL_R;
				const r0 = r1 - (bankMajor(deg) ? 7 : 4);
				return (
					<line key={deg}
						x1={Math.cos(rad) * r0} y1={Math.sin(rad) * r0}
						x2={Math.cos(rad) * r1} y2={Math.sin(rad) * r1}
						stroke={bankMajor(deg) ? STROKE : STROKE_DIM}
						strokeWidth={bankMajor(deg) ? 1.5 : 1} />
				);
			})}
			{known ? (
				<g transform={`rotate(${-rollDeg!})`}>
					<polygon points={`0,${-BALL_R + 2} -4,${-BALL_R + 10} 4,${-BALL_R + 10}`}
						fill={STROKE} />
				</g>
			) : null}

			{/* Aircraft reference. */}
			<g stroke={STROKE} strokeWidth={2} fill="none">
				<line x1={-17} y1={0} x2={-6} y2={0} />
				<line x1={17} y1={0} x2={6} y2={0} />
			</g>
			<circle cx={0} cy={0} r={1.6} fill={STROKE} />

			{/* The numbers, because reading a 92 px disc to the degree is guesswork. */}
			<text x={0} y={BALL_R + BALL_LABEL_DROP} textAnchor="middle" style={{ font: FONT }}
				fill={known ? STROKE : "rgba(255,120,120,0.9)"}>
				{known ? `${rollLabel(rollDeg)}  ${pitchLabel(pitchDeg)}` : "NO ATTITUDE"}
			</text>
		</g>
	);
});

interface TapeSpec { step: number; labelEvery: number; pxPerUnit: number; halfPx: number }

/** One vertical tape: ticks scrolling against a fixed boxed readout. */
const Tape = memo(function Tape({
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
				style={{ font: FONT }} fill={STROKE_UNIT}>
				{caption}
			</text>
			{sub ? (
				<text x={0} y={spec.halfPx + 31} textAnchor="middle"
					style={{ font: FONT }} fill={subTone ?? STROKE_UNIT}>
					{sub}
				</text>
			) : null}
		</g>
	);
});

/** The heading tape across the top: cardinals as letters, exact bearing under
 *  the pointer. Memoised on a quantised bearing, so a steady orbit redraws it
 *  about twice a second rather than ten times. */
const HeadingTape = memo(function HeadingTape(
	{ cx, deg }: { cx: number; deg: number | null },
) {
	if (deg === null) return null;
	const halfPx = cx * 0.42;
	return (
		<g transform={`translate(${cx} 34)`}>
			<line x1={-halfPx} y1={14} x2={halfPx} y2={14}
				stroke={STROKE_DIM} strokeWidth={1} />
			{headingTicks(deg).map((t) => (
				<g key={`${t.deg}:${t.offsetDeg}`}
					transform={`translate(${t.offsetDeg * (halfPx / 40)} 0)`}>
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
			))}
			{/* Pointer and the exact heading: reading a tape to the degree is
			    slower than reading three digits. */}
			<polygon points="0,16 -6,26 6,26" fill={STROKE} />
			<text x={0} y={39} textAnchor="middle" style={{ font: FONT }} fill={STROKE}>
				{String(Math.round(deg) % 360).padStart(3, "0")}
			</text>
		</g>
	);
});
