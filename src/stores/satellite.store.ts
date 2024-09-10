import { persistentAtom } from '@nanostores/persistent';
import type { Satellite } from '@/types/app';


// Initialize the store with an empty array
export const $satellitesStore = persistentAtom<Satellite[]>('satelliteElementsStore', [], {
  encode: JSON.stringify,
  decode: JSON.parse
});

export function addSatellite(element: Satellite) {
  const currentElements = $satellitesStore.get();
  $satellitesStore.set([...currentElements, element]);
}

export function getSatelliteById(_id: string): Satellite | undefined {
  const currentElements = $satellitesStore.get();
  return currentElements.find(element => element._id === _id);
}

export function updateSatelliteById(_id: string, updatedElement: Satellite) {
  const currentElements = $satellitesStore.get();
  const newElements = currentElements.map(element => (element._id === _id ? updatedElement : element));
  $satellitesStore.set(newElements);
}

export function updateSatellitePropById(_id: string, key: keyof Satellite, value: Satellite[keyof Satellite]) {
  const currentElements = $satellitesStore.get();
  const updatedElements = currentElements.map(element => {
    if (element._id === _id) {
      return {
        ...element,
        [key]: value
      };
    }
    return element;
  });
  $satellitesStore.set(updatedElements);
}

export function removeSatelliteById(_id: string) {
  const currentElements = $satellitesStore.get();
  const newElements = currentElements.filter(element => element._id !== _id);
  $satellitesStore.set(newElements);
}