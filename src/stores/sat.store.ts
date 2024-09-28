import { persistentAtom } from '@nanostores/persistent';
import type { Satellite } from '@/types/app';


// Initialize the store with an empty array
export const $satStore = persistentAtom<Satellite[]>('orbitStore', [], {
  encode: JSON.stringify,
  decode: JSON.parse
});

export function addSat(element: Satellite) {
  $satStore.set([...$satStore.get(), element]);
}

export function getSatById(_id: string): Satellite | undefined {
  return $satStore.get().find(element => element._id === _id);
}

export function updateSatById(_id: string, updatedElement: Satellite) {
  const newElements = $satStore.get().map(element => (element._id === _id ? updatedElement : element));
  $satStore.set(newElements);
}

export function updateSatPropById(_id: string, key: keyof Satellite, value: Satellite[keyof Satellite]) {
  const updatedElements = $satStore.get().map(element => {
    if (element._id === _id) {
      return {
        ...element,
        [key]: value
      };
    }
    return element;
  });
  $satStore.set(updatedElements);
}

export function removeSatById(_id: string) {
  const newElements = $satStore.get().filter(element => element._id !== _id);
  $satStore.set(newElements);
}