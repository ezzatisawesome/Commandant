import { propagate } from "@/services/api";
import { addState } from "@/stores/states.store";
import type { ClassicalOrbitalElements } from "@/types/app";

export class Satellite {
	id: string;
	coes: ClassicalOrbitalElements;
	states: number[][];
	currentStateIndex: number;
	requestInProgress: boolean;

	constructor(id: string, coes: ClassicalOrbitalElements) {
		this.id = id;
		this.coes = coes;
		this.states = [];
		this.currentStateIndex = 0;
		this.requestInProgress = false;
	}

	// Async initialization method.
	async init() {
		await this.propagate();
	}

	async propagate(withState?: boolean) {
		if (this.requestInProgress) return;
		this.requestInProgress = true;

		const response = await propagate(
			0,
			withState ? this.states[this.states.length - 1] : this.coes,
			2500,
			1,
			withState
		);
		this.states.push(...response.statesSat);
		addState(this.id, response.statesSat);

		this.requestInProgress = false;
	}


  incrementIndex() {
    this.currentStateIndex += 1;
  }
}
