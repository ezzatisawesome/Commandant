import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { PlayIcon, PauseIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon } from '@radix-ui/react-icons';

import { $viewerStore } from '@/stores/cesium.store';

const multipliers = [-500, -250, -200, -150, -100, -50, -25, -10, -5, -2, 1, 2, 5, 10, 25, 50, 100, 150, 200, 250, 500];

export default function TimeInterface() {
    const $viewer = useStore($viewerStore);
    const [isPlaying, setIsPlaying] = useState(false);
    const [multiplierIndex, setMultiplierIndex] = useState(Math.floor(multipliers.length / 2));


    const handleTogglePlay = () => {
        if ($viewer) $viewer.clock.shouldAnimate = !isPlaying;
        setIsPlaying(!isPlaying);
    };

    const incrementMultiplier = () => {
        setMultiplierIndex((prevIndex) => (prevIndex + 1) % multipliers.length);
        if ($viewer) {
            $viewer.clock.multiplier = multipliers[(multiplierIndex + 1) % multipliers.length];
        }
    };

    const decrementMultiplier = () => {
        setMultiplierIndex((prevIndex) => (prevIndex - 1 + multipliers.length) % multipliers.length);
        if ($viewer) {
            $viewer.clock.multiplier = multipliers[(multiplierIndex - 1 + multipliers.length) % multipliers.length];
        }
    };

    return (
        <div className="fixed bottom-4 left-4 space-x-0.5 flex items-center">
            <button onClick={decrementMultiplier}>
                <DoubleArrowLeftIcon className="stroke-white stroke-0 w-4 h-4" />
            </button>
            <button onClick={handleTogglePlay}>
                {isPlaying ? (
                    <PauseIcon className="stroke-white stroke-0 w-5 h-5" />
                ) : (
                    <PlayIcon className="stroke-white stroke-0 w-5 h-5" />
                )}
            </button>
            <button onClick={incrementMultiplier}>
                <DoubleArrowRightIcon className="stroke-white stroke-0 w-4 h-4" />
            </button>
            <span className="pl-2 text-sm text-white">{multipliers[multiplierIndex]}x</span>
        </div>
    );
}
