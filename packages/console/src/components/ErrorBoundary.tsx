"use client";

import { Component, type ReactNode } from "react";

// Last line of defence for the control panels: one render-time exception (a
// field shape gs didn't promise, a bad frame) must degrade a single panel to a
// retry card, never unmount the whole console mid-flight.
export class ErrorBoundary extends Component<
	{ name: string; children: ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error) {
		console.error(`[${this.props.name}] render failed`, error);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="w-64 rounded-md border border-red-500/40 bg-black/70 p-3 text-xs text-red-300 backdrop-blur">
				<div className="font-semibold">{this.props.name} crashed</div>
				<div className="mt-1 truncate text-[10px] text-red-200/70" title={this.state.error.message}>
					{this.state.error.message}
				</div>
				<button
					onClick={() => this.setState({ error: null })}
					className="mt-2 rounded border border-white/20 px-2 py-0.5 text-[10px] text-white/80 hover:bg-white/10"
				>
					retry
				</button>
			</div>
		);
	}
}
