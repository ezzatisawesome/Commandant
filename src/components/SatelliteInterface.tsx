import { useState } from 'react';
import { useStore } from "@nanostores/react"

import type { ClassicalOrbitalElements } from '@/types/orbits';
import { generateId } from '@/lib/utils';
import { $orbitalElementsStore } from '@/stores/satellite.store';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from "@/ui/label"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"


export default function SatelliteInterface() {
    const $orbitalElements = useStore($orbitalElementsStore);
    const [orbitalParams, setOrbitalParams] = useState<ClassicalOrbitalElements>($orbitalElements[0]);

    const handleChange = (param: keyof ClassicalOrbitalElements, value: number) => {
        setOrbitalParams(prevParams => ({
            ...prevParams,
            [param]: value,
        } as ClassicalOrbitalElements));

        // Save the changes to the store
        $orbitalElementsStore.set([{
            id: generateId(),
            ...orbitalParams,
        }]);
    };

    return (
        <div className="p-1 fixed top-0 left-0">
            <Popover>
                <PopoverTrigger asChild>
                    <Button variant="outline">Captain</Button>
                </PopoverTrigger>
                <PopoverContent className="m-1 grid gap-1">
                    <div className="grid grid-cols-4 items-center">
                        <Label>a</Label>
                        <Input
                            type="number"
                            value={orbitalParams?.semiMajorAxis}
                            onChange={e => handleChange("semiMajorAxis", parseFloat(e.target.value))}
                            className="col-span-3 h-8"
                        />
                    </div>
                    <div className="grid grid-cols-4 items-center">
                        <Label>e</Label>
                        <Input
                            type="number"
                            value={orbitalParams?.eccentricity}
                            onChange={e => handleChange("eccentricity", parseFloat(e.target.value))}
                            className="col-span-3 h-8"
                        />
                    </div>
                    <div className="grid grid-cols-4 items-center">
                        <Label>i</Label>
                        <Input
                            type="number"
                            value={orbitalParams?.inclination}
                            onChange={e => handleChange("inclination", parseFloat(e.target.value))}
                            className="col-span-3 h-8"
                        />
                    </div>
                    <div className="grid grid-cols-4 items-center">
                        <Label>Ω</Label>
                        <Input
                            type="number"
                            value={orbitalParams?.longitudeAscendingNode}
                            onChange={e => handleChange("longitudeAscendingNode", parseFloat(e.target.value))}
                            className="col-span-3 h-8"
                        />
                    </div>
                    <div className="grid grid-cols-4 items-center">
                        <Label>ω</Label>
                        <Input
                            type="number"
                            value={orbitalParams?.argumentOfPeriapses}
                            onChange={e => handleChange("argumentOfPeriapses", parseFloat(e.target.value))}
                            className="col-span-3 h-8"
                        />
                    </div>
                    <div className="grid grid-cols-4 items-center">
                        <Label>ν</Label>
                        <Input
                            type="number"
                            value={orbitalParams?.trueAnomaly}
                            onChange={e => handleChange("trueAnomaly", parseFloat(e.target.value))}
                            className="col-span-3 h-8"
                        />
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    );
}