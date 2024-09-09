import { propagate } from "@/services/api";
import { $statesStore } from "@/stores/states.store";

export class Satellite {
	coes: number[];
	states: number[][];
	currentStateIndex: number;
	requestInProgress: boolean;

	constructor(coes: number[]) {
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
		$statesStore.set([...this.states]);

		this.requestInProgress = false;
	}


  incrementIndex() {
    this.currentStateIndex += 1;
  }
}
