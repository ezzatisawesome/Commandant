import { atom } from "nanostores";

type SatelliteState = number[][];

export const $statesStore = atom<SatelliteState>([]);