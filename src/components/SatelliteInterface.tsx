import { useStore } from "@nanostores/react"
import { PlusIcon, TrashIcon } from '@radix-ui/react-icons';

import type { Orbit, ClassicalOrbitalElements } from '@/types/app';
import { generateId } from '@/lib/utils';
import { $orbitStore, addOrbit, updateOrbitPropById, removeOrbitById } from '@/stores/orbit.store';
import { Button } from '@/ui/button';
import { Label } from "@/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"


export default function SatelliteInterface() {
    const $orbits = useStore($orbitStore);

    const handleAddSatellite = () => {
        const newSatellite = {
            _id: generateId(),
            name: "New Satellite",
            semiMajorAxis: 6771, // km (Earth's radius + 400 km altitude)
            eccentricity: 0.001, // near-circular orbit
            inclination: 51.6, // degrees (common inclination for LEO)
            longitudeAscendingNode: 0, // degrees
            argumentOfPeriapses: 0, // degrees
            trueAnomaly: 0, // degrees
        };
        addOrbit(newSatellite);
    };

    const handleChange = (id: string, key: keyof ClassicalOrbitalElements, value: number) => {
        updateOrbitPropById(id, key, value);
    };

    const handleDeleteSatellite = (id: string) => {
        removeOrbitById(id);
    };

    const orbitalElements = [
        { label: 'a', key: 'semiMajorAxis' },
        { label: 'e', key: 'eccentricity' },
        { label: 'i', key: 'inclination' },
        { label: 'Ω', key: 'longitudeAscendingNode' },
        { label: 'ω', key: 'argumentOfPeriapses' },
        { label: 'ν', key: 'trueAnomaly' },
    ];

    return (
        <div className="fixed top-4 left-4">
            <Button onClick={handleAddSatellite} variant="ghost" className="text-xs py-1 -mx-2 px-2 h-min">
                Add Satellite <PlusIcon className="ml-2 w-4 h-4" />
            </Button>
            <div className="grid gap-1 pt-2">
                {$orbits.map((o: Orbit) => (
                    <Popover key={o._id}>
                        <PopoverTrigger asChild>
                            <div className="hover:underline hover:cursor-pointer text-xs p-0 m-0">{o.name}</div>
                        </PopoverTrigger>
                        <PopoverContent className="ml-2 grid gap-1.5 w-min shadow-lg">
                            {orbitalElements.map(element => (
                                <div key={element.key} className="flex items-center gap-2">
                                    <Label className='w-5 font-light'>{element.label}:</Label>
                                    <input
                                        type="number"
                                        value={o[element.key as keyof ClassicalOrbitalElements]}
                                        onChange={e => handleChange(o._id, element.key as keyof ClassicalOrbitalElements, parseFloat(e.target.value))}
                                        className="bg-transparent border-b focus:outline-none focus:ring-0 text-center text-sm"
                                    />
                                </div>
                            ))}
                            <Button onClick={() => handleDeleteSatellite(o._id)} variant="ghost" className="mt-2 text-xs h-6">
                                Delete <TrashIcon className="ml-2 w-4 h-4" />
                            </Button>
                        </PopoverContent>
                    </Popover>
                ))}
            </div>
        </div>
    );
}