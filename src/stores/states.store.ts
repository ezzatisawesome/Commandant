import { atom, map } from "nanostores";
import { JulianDate } from "cesium";

export const $timeStore = atom<JulianDate>(JulianDate.fromDate(new Date(2024, 2, 20, 0, 0, 0)));
export const $statesStore = map<Record<string, number[][]>>({});

export function addState(id: string, states: number[][]) {
    const currentStates = $statesStore.get()[id];
    if (!currentStates) {
        $statesStore.setKey(id, states);
        return;
    }
    $statesStore.setKey(id, [...currentStates, ...states]);
}
