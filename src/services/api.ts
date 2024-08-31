import { API_ENDPOINT } from "../consts";


type PropagateResponse = {
	message: string;
	statesSat: number[][];
	statesGeocSat: number[][];
};

const propagate = async (	
    time: number,
	coes: number[],
	propagationSpan: number,
	propagationStep: number
) : Promise<PropagateResponse> => {
	const payload = {
		time,
		coes,
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
