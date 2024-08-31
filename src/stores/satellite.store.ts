import { persistentAtom } from '@nanostores/persistent';

// Define the classical orbital elements with an id
interface OrbitalElements {
  id: string;
  semiMajorAxis: number;
  eccentricity: number;
  inclination: number;
  rightAscension: number;
  argumentOfPeriapsis: number;
  trueAnomaly: number;
}

// Initialize the store with an empty array
export const $orbitalElementsStore = persistentAtom<OrbitalElements[]>('orbitalElementsStore', [], {
  encode: JSON.stringify,
  decode: JSON.parse
});

// Helper function to add orbital elements
export function addOrbitalElement(element: OrbitalElements) {
  const currentElements = $orbitalElementsStore.get();
  $orbitalElementsStore.set([...currentElements, element]);
}

// Helper function to get an orbital element by id
export function getOrbitalElementById(id: string): OrbitalElements | undefined {
  const currentElements = $orbitalElementsStore.get();
  return currentElements.find(element => element.id === id);
}

// Helper function to update an orbital element by id
export function updateOrbitalElementById(id: string, updatedElement: OrbitalElements) {
  const currentElements = $orbitalElementsStore.get();
  const newElements = currentElements.map(element => (element.id === id ? updatedElement : element));
  $orbitalElementsStore.set(newElements);
}

// Helper function to remove an orbital element by id
export function removeOrbitalElementById(id: string) {
  const currentElements = $orbitalElementsStore.get();
  const newElements = currentElements.filter(element => element.id !== id);
  $orbitalElementsStore.set(newElements);
}