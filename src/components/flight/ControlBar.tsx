"use client";

// Bipolar control-deflection indicator. A fixed horizontal track with a centre
// detent (zero); a vertical bar slides right for a positive command and left for
// a negative one, with the fill growing from centre so the magnitude reads at a
// glance. Value is a percent of full deflection (-100..100); undefined => centred.
export function ControlBar({
	value,
	width = 60,
	height = 16,
	className = "text-cyan-400/80",
}: {
	value: number | undefined;
	width?: number;
	height?: number;
	className?: string;
}) {
	const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
	const clamped = Math.max(-100, Math.min(100, v));
	const cx = width / 2;
	const half = width / 2 - 1; // keep the bar inside the track
	const x = cx + (clamped / 100) * half;
	const barW = 2;

	// fill spans from centre to the current position (either side)
	const fillX = Math.min(cx, x);
	const fillW = Math.abs(x - cx);

	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className={className}
			aria-hidden
		>
			{/* track */}
			<rect x={0.5} y={height / 2 - 3} width={width - 1} height={6} rx={2}
				fill="currentColor" fillOpacity={0.12} />
			{/* centre detent */}
			<line x1={cx} y1={2} x2={cx} y2={height - 2}
				stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
			{/* magnitude fill from centre */}
			<rect x={fillX} y={height / 2 - 3} width={fillW} height={6}
				fill="currentColor" fillOpacity={0.45} />
			{/* moving indicator bar */}
			<rect x={x - barW / 2} y={1} width={barW} height={height - 2} rx={1}
				fill="currentColor" />
		</svg>
	);
}
