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
	orbitalPeriod: number;
	sensorRadius?: number;

	constructor(id: string, coes: ClassicalOrbitalElements, sensorRadius?: number) {
		this.id = id;
		this.coes = coes;
		this.states = [];
		this.nStates = [];
		this.currentStateIndex = 0;
		this.requestInProgress = false;
		this.orbitalPeriod = Satellite.getOrbitalPeriod(coes.semiMajorAxis);
		this.sensorRadius = sensorRadius;
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
			reverse ? -this.orbitalPeriod : this.orbitalPeriod,
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

	static getOrbitalPeriod(sma: number): number {
		const mu = 3.986004418e5;
		return 2 * Math.PI * Math.sqrt(Math.pow(sma, 3) / mu);
	}
}
