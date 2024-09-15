import { API_ENDPOINT } from "../consts";

import type { ClassicalOrbitalElements, StateElements } from "@/types/app";


type PropagateResponse = {
	message: string;
	statesSat: StateElements[];
	statesGeocSat: number[][];
};

const propagate = async (	
	time: number,
	elements: StateElements | ClassicalOrbitalElements, // Either coes or state vector
	propagationSpan: number,
	propagationStep: number,
	fromState: boolean = false,
) : Promise<PropagateResponse> => {
	const payload = {
		from_state: fromState,
		time,
		elements: Object.values(elements),
		propagation_span: propagationSpan,
		propagation_step: propagationStep,
	};

	try {
		const response = await fetch(`${API_ENDPOINT}/propagate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			throw new Error(`Error: ${response.statusText}`);
		}

		const data: PropagateResponse = await response.json();
		return data;
	} catch (error) {
		console.error("Error calling propagate API:", error);
		throw error;
	}
}

export { propagate };
