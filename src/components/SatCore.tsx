import { useState } from 'react';
import { TrashIcon } from '@radix-ui/react-icons';

import type { Satellite, ClassicalOrbitalElements } from '@/types/app';
import { updateSatById, removeSatById } from '@/stores/sat.store';
import { Button } from '@/ui/button';
import { Label } from "@/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"


export interface ISatCoreProps {
    sat: Satellite;
}

export default function OrbitCore(props: ISatCoreProps) {
    const [renameValue, setRenameValue] = useState(props.sat.name);
    const [localSatellite, setLocalSatellite] = useState<Satellite>({...props.sat});

    const handleChange = (key: keyof Satellite, value: Satellite[keyof Satellite]) => {
        setLocalSatellite(prev => ({
            ...prev,
            [key]: value,
        }));
    };

    const handleSaveSatellite = () => {
        updateSatById(localSatellite._id, localSatellite);
    };

    const handleDeleteSatellite = (id: string) => {
        removeSatById(id);
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
                <div className="hover:underline hover:cursor-pointer text-xs p-0 m-0">{props.sat.name}</div>
            </PopoverTrigger>
            <PopoverContent className="ml-2 grid gap-1.5 w-min shadow-lg p-3">
                <div className='flex justify-center border p-1 mb-2'>
                    <input
                        type="text"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={e => handleChange('name', e.target.value)}
                        className="bg-transparent focus:outline-none focus:ring-0 text-center text-sm"
                    />
                </div>
                {orbitalElements.map(element => (
                    <div key={element.key} className="flex items-center gap-2">
                        <Label className='w-5 font-light'>{element.label}:</Label>
                        <input
                            type="number"
                            value={localSatellite[element.key as keyof ClassicalOrbitalElements]}
                            onChange={e => handleChange(element.key as keyof ClassicalOrbitalElements, parseFloat(e.target.value))}
                            className="bg-transparent border-b focus:outline-none focus:ring-0 text-center text-sm"
                        />
                    </div>
                ))}
                <div className="flex items-center gap-2">
                    <Label className='w-5 font-light'>Sensor radius:</Label>
                    <input
                        type="number"
                        value={localSatellite.sensorRadius || 0}
                        onChange={e => handleChange('sensorRadius', parseFloat(e.target.value))}
                        className="bg-transparent border-b focus:outline-none focus:ring-0 text-center text-sm"
                    />
                </div>

                <div className="grid grid-cols-6">
                    <Button onClick={handleSaveSatellite} variant="ghost" className="col-span-5 text-xs h-6">
                        Save
                    </Button>
                    <Button onClick={() => handleDeleteSatellite(props.sat._id)} variant="ghost" className="col-span-1 text-xs h-6 p-0">
                        <TrashIcon className="w-4 h-4" />
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
