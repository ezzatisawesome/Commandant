import { useState } from 'react';
import { TrashIcon } from '@radix-ui/react-icons';

import type { Orbit, ClassicalOrbitalElements } from '@/types/app';
import { updateOrbitPropById, removeOrbitById } from '@/stores/orbit.store';
import { Button } from '@/ui/button';
import { Label } from "@/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"


export interface IOrbitProps {
    orbit: Orbit;
}

export default function OrbitCore(props: IOrbitProps) {
    const [renameValue, setRenameValue] = useState(props.orbit.name);

    const handleChange = (id: string, key: keyof Orbit, value: Orbit[keyof Orbit]) => {
        updateOrbitPropById(id, key, value);
    };

    const handleDeleteSatellite = (id: string) => {
        removeOrbitById(id);
    };

    const handleRenameSatellite = (id: string, newName: string) => {
        if (newName.trim() !== '') {
            updateOrbitPropById(id, 'name', newName);
        } else {
            setRenameValue(props.orbit.name); // Revert to the current name if input is empty
        }
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
        <Popover>
            <PopoverTrigger asChild>
                <div className="hover:underline hover:cursor-pointer text-xs p-0 m-0">{props.orbit.name}</div>
            </PopoverTrigger>
            <PopoverContent className="ml-2 grid gap-1.5 w-min shadow-lg">
                <input
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={e => handleRenameSatellite(props.orbit._id, e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            handleRenameSatellite(props.orbit._id, e.currentTarget.value);
                        }
                    }}
                    className="bg-transparent border-b focus:outline-none focus:ring-0 text-center text-sm"
                />
                {orbitalElements.map(element => (
                    <div key={element.key} className="flex items-center gap-2">
                        <Label className='w-5 font-light'>{element.label}:</Label>
                        <input
                            type="number"
                            value={props.orbit[element.key as keyof ClassicalOrbitalElements]}
                            onChange={e => handleChange(props.orbit._id, element.key as keyof ClassicalOrbitalElements, parseFloat(e.target.value))}
                            className="bg-transparent border-b focus:outline-none focus:ring-0 text-center text-sm"
                        />
                    </div>
                ))}
                <Button onClick={() => handleDeleteSatellite(props.orbit._id)} variant="ghost" className="mt-2 text-xs h-6">
                    Delete <TrashIcon className="ml-2 w-4 h-4" />
                </Button>
            </PopoverContent>
        </Popover>
    );
}
