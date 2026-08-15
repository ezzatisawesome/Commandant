"use client";

// Tiny inline sparkline. Pure SVG, no charting dependency — sized to sit next
// to a HUD field. Auto-scales to the min/max of the values it's given.
export function Sparkline({
	values,
	width = 60,
	height = 16,
	className = "text-emerald-400/80",
}: {
	values: Array<number | undefined>;
	width?: number;
	height?: number;
	className?: string;
}) {
	// Keep only finite samples; a gap-free line reads better than a spiky one.
	const pts = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

	if (pts.length < 2) {
		// Not enough history yet — render an empty box so layout doesn't jump.
		return <svg width={width} height={height} className={className} aria-hidden />;
	}

	const min = Math.min(...pts);
	const max = Math.max(...pts);
	const range = max - min || 1; // avoid /0 on a flat series
	const pad = 1; // keep the stroke off the top/bottom edges
	const usable = height - pad * 2;
	const step = width / (pts.length - 1);

	const points = pts
		.map((v, i) => {
			const x = i * step;
			const y = pad + usable - ((v - min) / range) * usable;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");

	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className={className}
			aria-hidden
		>
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth={1}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	);
}
