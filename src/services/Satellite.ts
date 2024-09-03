import { propagate } from "@/services/api";
import { $statesStore } from "@/stores/states.store";

export class Satellite {
	coes: number[];
	states: number[][];
	currentStateIndex: number;

	constructor(coes: number[]) {
		this.coes = coes;
		this.states = [];
    this.currentStateIndex = 0;
	}

	// Async initialization method.
	async init() {
		await this.propagate();
	}

	async propagate(withState?: boolean) {
		const response = await propagate(
			0,
			withState ? this.states[this.states.length - 1] : this.coes,
			10000,
			1,
			withState
		);
		this.states.push(...response.statesSat);
		$statesStore.set([...this.states]);
	}


  incrementIndex() {
    this.currentStateIndex += 1;
  }
}
