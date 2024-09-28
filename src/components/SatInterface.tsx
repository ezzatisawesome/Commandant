import { useStore } from "@nanostores/react"
import { PlusIcon } from '@radix-ui/react-icons';

import type { Satellite } from '@/types/app';
import { generateId } from '@/lib/utils';
import { $satStore, addSat } from '@/stores/sat.store';
import { Button } from '@/ui/button';
import SatCore from "@/components/SatCore";


export default function OrbitInterface() {
    const $orbits = useStore($satStore);

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
        addSat(newSatellite);
    };

    return (
        <div className="fixed top-4 left-4">
            <Button onClick={handleAddSatellite} variant="ghost" className="text-xs py-1 -mx-2 px-2 h-min">
                Add Satellite <PlusIcon className="ml-2 w-4 h-4" />
            </Button>
            <div className="grid gap-1 pt-2">
                {$orbits.map((s: Satellite) => (
                    <SatCore key={s._id} sat={s}/>
                ))}
            </div>
        </div>
    );
}