import { propagate } from "@/services/api";
import { $statesStore } from "@/stores/states.store";


export class Satellite {
  coes: number[];
  states: number[][];

  constructor(coes: number[]) {
    this.coes = coes;
    this.states = [];
  }

  // Async initialization method.
  async init() {
    const response = await propagate(0, this.coes, 5400, 1);
    this.states = response.statesSat;
    $statesStore.set(this.states);
  }

  
}