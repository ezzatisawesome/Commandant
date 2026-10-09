"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "@nanostores/react";

import { $globeAuthoring, shouldDismissOnOutsideClick } from "@/stores/authoring.store";

// The dock: a slim column of icons on the right edge, with at most one panel
// open at a time.
//
// It replaces a rail that stacked seven always-open panels down the right side
// of the screen. That rail cost roughly a quarter of the viewport permanently,
// and the viewport is the instrument — the 3D world is what the operator is
// actually reading. Everything that is not needed continuously is now one click
// away and closes on the next click, on Escape, or when another is opened — the
// exception being the two authoring panels while their map-edit mode is on,
// since there every globe click is work being done through the open panel.
//
// Rules this enforces structurally rather than by convention:
//
//  1. One panel at a time. Two open panels is a rail again.
//  2. Nothing is pinned to the left edge. The globe's horizon and the bottom
//     telemetry strip own that space.
//  3. The dock is narrow enough (36 px) to read as a gutter, not a sidebar.

export interface DockItem {
	key: string;
	label: string;
	icon: ReactNode;
	panel: ReactNode;
}

/** Which panel is open after clicking `clicked`, given `current`.
 *
 *  Pulled out as a pure function so rule 1 is testable without mounting Cesium:
 *  clicking a new icon replaces the open panel rather than adding to it, and
 *  clicking the open one closes it. */
export function nextOpen(current: string | null, clicked: string): string | null {
	return current === clicked ? null : clicked;
}

export function Dock({ items }: { items: DockItem[] }) {
	const [open, setOpen] = useState<string | null>(null);
	const wrap = useRef<HTMLDivElement>(null);
	// While the operator is authoring on the globe, a click on the globe is work,
	// not a dismissal — see the store.
	const authoring = useStore($globeAuthoring);

	// Escape closes, and so does a click outside — except while the operator is
	// authoring on the globe, when that click IS the panel being used. A panel
	// that needs an explicit close button is a panel that stays open by accident.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
		const onDown = (e: PointerEvent) => {
			if (wrap.current?.contains(e.target as Node)) return;
			if (shouldDismissOnOutsideClick(authoring)) setOpen(null);
		};
		window.addEventListener("keydown", onKey);
		// `true`: Cesium stops propagation on the canvas, so listen on the way down.
		window.addEventListener("pointerdown", onDown, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("pointerdown", onDown, true);
		};
	}, [open, authoring]);

	const active = items.find((i) => i.key === open) ?? null;

	return (
		<div ref={wrap} className="fixed right-3 top-1/2 z-50 flex -translate-y-1/2 items-start gap-2">
			{/* The panel opens inboard of the dock, so the icons never move. */}
			{active ? (
				<div
					role="dialog"
					aria-label={active.label}
					// Capped so an open panel cannot reach the telemetry strip along
					// the bottom edge or the heading tape across the top.
					className="max-h-[calc(100vh-13rem)] overflow-y-auto rounded-md border border-white/10 bg-black/70 p-3 backdrop-blur"
				>
					{active.panel}
				</div>
			) : null}

			<div className="flex w-9 flex-col gap-1 rounded-md border border-white/10 bg-black/50 p-1 backdrop-blur">
				{items.map((i) => (
					<button
						key={i.key}
						title={i.label}
						aria-label={i.label}
						aria-pressed={open === i.key}
						onClick={() => setOpen((o) => nextOpen(o, i.key))}
						className={`flex h-7 w-7 items-center justify-center rounded ${
							open === i.key
								? "bg-white/15 text-white"
								: "text-white/45 hover:bg-white/10 hover:text-white"
						}`}
					>
						{i.icon}
					</button>
				))}
			</div>
		</div>
	);
}

export default Dock;
