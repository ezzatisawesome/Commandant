import { atom, map } from "nanostores";
import * as Cesium from "cesium";

export const $timeStore = atom<Cesium.JulianDate>(Cesium.JulianDate.fromDate(new Date(2024, 2, 20, 0, 0, 0)));
export const $statesStore = map<Record<string, number[][]>>({});

export function addState(id: string, states: number[][], reverse?: boolean) {
    const currentStates = $statesStore.get()[id];
    if (!currentStates) {
        $statesStore.setKey(id, states);
        return;
    }

    if (reverse) $statesStore.setKey(id, [...states, ...currentStates]);
    else $statesStore.setKey(id, [...currentStates, ...states]);
}
