"use client";

// Artificial horizon driven by roll/pitch (radians, as decoded from MAVLink
// ATTITUDE). The sky/ground disc rolls opposite the aircraft and slides with
// pitch; a fixed aircraft symbol + roll pointer sit on top. Pure SVG.
export function AttitudeIndicator({
	roll = 0,
	pitch = 0,
	size = 92,
}: {
	roll?: number;
	pitch?: number;
	size?: number;
}) {
	const r = size / 2;
	const rollDeg = (roll * 180) / Math.PI;
	const pitchDeg = (pitch * 180) / Math.PI;
	const pxPerDeg = 1.5;
	// Nose-up (positive pitch) should reveal more sky → push the horizon down.
	const pitchOffset = pitchDeg * pxPerDeg;

	// Pitch ladder rungs every 10°.
	const rungs = [-30, -20, -10, 10, 20, 30];

	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
			<defs>
				<clipPath id="attitude-clip">
					<circle cx={r} cy={r} r={r - 1} />
				</clipPath>
			</defs>

			<g clipPath="url(#attitude-clip)">
				<g transform={`rotate(${-rollDeg} ${r} ${r})`}>
					<g transform={`translate(0 ${pitchOffset})`}>
						{/* Sky and ground */}
						<rect x={r - 200} y={r - 400} width={400} height={400} fill="#3a7bd5" />
						<rect x={r - 200} y={r} width={400} height={400} fill="#7a5230" />
						{/* Horizon line */}
						<line x1={r - 200} y1={r} x2={r + 200} y2={r} stroke="white" strokeWidth={1.5} />
						{/* Pitch ladder */}
						{rungs.map((deg) => {
							const y = r - deg * pxPerDeg;
							const half = deg % 20 === 0 ? 16 : 9;
							return (
								<line
									key={deg}
									x1={r - half}
									y1={y}
									x2={r + half}
									y2={y}
									stroke="white"
									strokeWidth={1}
									opacity={0.8}
								/>
							);
						})}
					</g>
				</g>
			</g>

			{/* Bezel */}
			<circle cx={r} cy={r} r={r - 1} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={1} />

			{/* Fixed aircraft reference symbol */}
			<g stroke="#ffd34d" strokeWidth={2} fill="none">
				<line x1={r - 18} y1={r} x2={r - 6} y2={r} />
				<line x1={r + 6} y1={r} x2={r + 18} y2={r} />
				<circle cx={r} cy={r} r={1.5} fill="#ffd34d" />
			</g>

			{/* Fixed roll pointer at top */}
			<polygon
				points={`${r},3 ${r - 4},9 ${r + 4},9`}
				fill="#ffd34d"
			/>
		</svg>
	);
}
