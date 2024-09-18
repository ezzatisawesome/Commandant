import { propagate } from "@/services/api";
import { addState } from "@/stores/states.store";
import type { ClassicalOrbitalElements } from "@/types/app";

export class Satellite {
	id: string;
	coes: ClassicalOrbitalElements;
	states: number[][];
	nStates: number[][];
	currentStateIndex: number;
	requestInProgress: boolean;

	constructor(id: string, coes: ClassicalOrbitalElements) {
		this.id = id;
		this.coes = coes;
		this.states = [];
		this.nStates = [];
		this.currentStateIndex = 0;
		this.requestInProgress = false;
	}

	// Async initialization method.
	async init() {
		await this.propagate();
		await this.propagate(false, true);
	}

	async propagate(withState?: boolean, reverse?: boolean) {
		if (this.requestInProgress) return;
		this.requestInProgress = true;

		const response = await propagate(
			0,
			withState ? (!reverse ? this.states[this.states.length - 1] : this.nStates[this.nStates.length - 1]) : this.coes,
			reverse ? -2500 : 2500,
			1,
			withState
		);

		if (reverse) this.nStates.push(...response.statesSat);
		else this.states.push(...response.statesSat);

		addState(this.id, response.statesSat);
		this.requestInProgress = false;
	}

	incrementIndex() {
		this.currentStateIndex += 1;
	}
}
