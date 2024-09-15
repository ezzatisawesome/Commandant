import { persistentAtom } from '@nanostores/persistent';
import type { Orbit } from '@/types/app';


// Initialize the store with an empty array
export const $orbitStore = persistentAtom<Orbit[]>('orbitStore', [], {
  encode: JSON.stringify,
  decode: JSON.parse
});

export function addOrbit(element: Orbit) {
  $orbitStore.set([...$orbitStore.get(), element]);
}

export function getOrbitById(_id: string): Orbit | undefined {
  return $orbitStore.get().find(element => element._id === _id);
}

export function updateOrbitById(_id: string, updatedElement: Orbit) {
  const newElements = $orbitStore.get().map(element => (element._id === _id ? updatedElement : element));
  $orbitStore.set(newElements);
}

export function updateOrbitPropById(_id: string, key: keyof Orbit, value: Orbit[keyof Orbit]) {
  const updatedElements = $orbitStore.get().map(element => {
    if (element._id === _id) {
      return {
        ...element,
        [key]: value
      };
    }
    return element;
  });
  $orbitStore.set(updatedElements);
}

export function removeOrbitById(_id: string) {
  const newElements = $orbitStore.get().filter(element => element._id !== _id);
  $orbitStore.set(newElements);
}