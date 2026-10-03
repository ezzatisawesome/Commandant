"use client";

// Heading compass card. The dial rotates so the current heading sits under the
// fixed top pointer; the numeric heading is shown in the center. Pure SVG.
export function Compass({ heading = 0, size = 92 }: { heading?: number; size?: number }) {
	const r = size / 2;
	const tickR = r - 4; // radius of the tick outer end
	const labelR = r - 14; // radius of the cardinal letters

	const marks = [];
	for (let b = 0; b < 360; b += 30) {
		const theta = (b * Math.PI) / 180;
		const sin = Math.sin(theta);
		const cos = Math.cos(theta);
		const cardinal = { 0: "N", 90: "E", 180: "S", 270: "W" }[b];
		// Tick
		marks.push(
			<line
				key={`t${b}`}
				x1={r + sin * tickR}
				y1={r - cos * tickR}
				x2={r + sin * (tickR - (cardinal ? 6 : 4))}
				y2={r - cos * (tickR - (cardinal ? 6 : 4))}
				stroke="white"
				strokeWidth={cardinal ? 1.5 : 1}
				opacity={cardinal ? 0.9 : 0.5}
			/>,
		);
		if (cardinal) {
			marks.push(
				<text
					key={`l${b}`}
					x={r + sin * labelR}
					y={r - cos * labelR}
					fill={cardinal === "N" ? "#ff6b6b" : "white"}
					fontSize={9}
					fontWeight={600}
					textAnchor="middle"
					dominantBaseline="central"
				>
					{cardinal}
				</text>,
			);
		}
	}

	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
			<circle cx={r} cy={r} r={r - 1} fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.25)" strokeWidth={1} />

			{/* Rotating dial */}
			<g transform={`rotate(${-heading} ${r} ${r})`}>{marks}</g>

			{/* Fixed top pointer */}
			<polygon points={`${r},2 ${r - 4},10 ${r + 4},10`} fill="#ffd34d" />

			{/* Center heading readout */}
			<text x={r} y={r} fill="white" fontSize={13} fontFamily="monospace" textAnchor="middle" dominantBaseline="central">
				{Math.round(((heading % 360) + 360) % 360)}
			</text>
			<text x={r} y={r + 12} fill="rgba(255,255,255,0.5)" fontSize={7} textAnchor="middle" dominantBaseline="central">
				HDG
			</text>
		</svg>
	);
}
