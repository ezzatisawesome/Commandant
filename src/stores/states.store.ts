import { atom, map } from "nanostores";
import { JulianDate } from "cesium";
import type { StateElements } from "@/types/app";

export const $statesStore = map<Record<string, StateElements[]>>({});

export function addState(id: string, states: StateElements[]) {
    const currentStates = $statesStore.get()[id];
    if (!currentStates) {
        $statesStore.setKey(id, states);
        return;
    }
    $statesStore.setKey(id, [...currentStates, ...states]);
}

export const $timeStore = atom<JulianDate>(JulianDate.fromDate(new Date(2024, 2, 20, 0, 0, 0)));