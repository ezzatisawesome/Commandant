import { useEffect, useRef } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { v4 as uuidv4 } from "uuid";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function generateId(): string {
	return uuidv4();
}

// Custom hook that runs the effect only when the inputs change
export function useDeepCompareEffect(callback: () => void, dependencies: any[]) {
	const previousDeps = useRef<any[]>();

	useEffect(() => {
		const hasChanged =
			!previousDeps.current ||
			dependencies.some((dep, i) => dep !== previousDeps.current?.[i]);

		if (hasChanged) {
			previousDeps.current = dependencies;
			callback();
		}
	}, [callback, ...dependencies]);
}
