import envs from "@/lib/envs"

import type { ClassicalOrbitalElements } from "@/types/app";


type PropagateResponse = {
	message: string;
	statesSat: number[][];
};

const propagate = async (	
	time: number,
	elements: ClassicalOrbitalElements | number[], // Either coes or state vector
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
		const response = await fetch(`${envs.PROPAGATE_ENDPOINT}/propagate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			throw new Error(`Error: ${response.statusText}`);
		}

		return await response.json();
	} catch (error) {
		console.error("Error calling propagate API:", error);
		throw error;
	}
}

export { propagate };
