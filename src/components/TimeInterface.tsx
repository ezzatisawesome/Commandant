"use client";

import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { PlayIcon, PauseIcon } from '@radix-ui/react-icons';

import { $viewerStore } from '@/stores/cesium.store';

export default function TimeInterface() {
    const $viewer = useStore($viewerStore);
    const [isPlaying, setIsPlaying] = useState(false);

    const handleTogglePlay = () => {
        if ($viewer) $viewer.clock.shouldAnimate = !isPlaying;
        setIsPlaying(!isPlaying);
    };

    return (
        <div className="fixed bottom-4 left-4 flex items-center">
            <button onClick={handleTogglePlay}>
                {isPlaying ? (
                    <PauseIcon className="stroke-white stroke-0 w-5 h-5" />
                ) : (
                    <PlayIcon className="stroke-white stroke-0 w-5 h-5" />
                )}
            </button>
        </div>
    );
}
