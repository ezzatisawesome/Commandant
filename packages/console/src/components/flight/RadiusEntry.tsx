"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";

import { $viewerStore } from "@/stores/cesium.store";
import { $radiusEntry, closeRadiusEntry } from "@/stores/radiusEntry.store";
import { clampRadius, snap } from "@/lib/grabbers";

// The typed-in diameter for a ring (see stores/radiusEntry.store): a box at the
// clicked handle, focused and pre-filled. Enter applies, Esc or clicking away
// cancels. Snapped and clamped exactly as a drag of the same handle would be.
export default function RadiusEntry() {
	const entry = useStore($radiusEntry);
	const viewer = useStore($viewerStore);
	const [text, setText] = useState("");
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!entry) return;
		setText(String(Math.round(entry.radiusM * 2)));
		requestAnimationFrame(() => input.current?.select());
	}, [entry]);

	if (!entry || !viewer) return null;
	const rect = viewer.scene.canvas.getBoundingClientRect();
	const diameter = Number(text);
	const valid = text.trim() !== "" && Number.isFinite(diameter) && diameter > 0;

	const submit = () => {
		if (!valid) return;
		entry.apply(snap(clampRadius(diameter / 2)));
		closeRadiusEntry();
	};

	return (
		<form
			onSubmit={(e) => { e.preventDefault(); submit(); }}
			className="fixed z-[55] flex items-center gap-1.5 rounded bg-black/80 px-2 py-1
				font-mono text-[11px] text-white shadow-lg backdrop-blur"
			style={{ left: rect.left + entry.x + 12, top: rect.top + entry.y - 14 }}
		>
			<span className="text-white/60">{entry.title} diameter</span>
			<input
				ref={input}
				value={text}
				inputMode="decimal"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => { if (e.key === "Escape") closeRadiusEntry(); }}
				onBlur={closeRadiusEntry}
				className={`w-16 rounded border bg-black/60 px-1 text-right text-white outline-none
					${valid ? "border-white/20 focus:border-white/50" : "border-red-400"}`}
				aria-label={`${entry.title} diameter in metres`}
			/>
			<span className="text-white/60">m</span>
		</form>
	);
}
