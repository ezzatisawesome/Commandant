import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import { CallbackProperty, Cartesian3, Color, JulianDate } from "cesium";

import { Satellite } from "@/services/Satellite";
import { $viewerStore } from "@/stores/cesium.store";
import { $timeStore } from "@/stores/states.store";
import { getOrbitById } from "@/stores/orbit.store";

interface ISatelliteProps {
    id: string;
}

export default function Satellites(props: ISatelliteProps) {
    const $viewer = useStore($viewerStore);
    const $time = useStore($timeStore);
    const satelliteRef = useRef<Satellite>(); // Ref to store the Satellite instance

    const getCartesian = (pos: number[]) => {
        const [x, y, z] = pos;
        return Cartesian3.fromElements(x * 1000, y * 1000, z * 1000);
    }

    useEffect(() => {
        const orbit = getOrbitById(props.id);
        if (orbit) {
            const params = {
                semiMajorAxis: orbit.semiMajorAxis,
                eccentricity: orbit.eccentricity,
                inclination: orbit.inclination,
                longitudeAscendingNode: orbit.longitudeAscendingNode,
                argumentOfPeriapses: orbit.argumentOfPeriapses,
                trueAnomaly: orbit.trueAnomaly
            }
            satelliteRef.current = new Satellite(props.id, params);
            satelliteRef.current.init();
        }
    }, [])

    useEffect(() => {
        const sat = satelliteRef.current;
        if ($viewer && sat) {
            const t0 = JulianDate.toDate($time).getTime() / 1000; // Initial start time in seconds
            $viewer.entities.add({
                polyline: {
                    positions: new CallbackProperty((time, result) => {
                        const currentTime = JulianDate.toDate(time).getTime() / 1000;
                        const stateIndex = Math.floor(currentTime - t0);

                        if (stateIndex + 500 > sat.states.length && sat.states.length !== 0) {
                            sat.propagate(true);
                        } else if (Math.abs(stateIndex) + 500 > sat.nStates.length && sat.nStates.length !== 0) {
                            sat.propagate(true, true);
                        }

                        if (stateIndex >= 0) {
                            return sat.states
                                .slice(stateIndex, stateIndex + 500)
                                .map(s => getCartesian(s));
                        } else if (stateIndex < 0 && stateIndex >= -500) {
                            const arr = [];

                            arr.push(...sat.states
                                .slice(0, stateIndex + 500)
                                .map(s => getCartesian(s)))

                            arr.push(...sat.nStates
                                .slice(0, Math.abs(stateIndex))
                                .map(s => getCartesian(s)))

                            return arr
                        } else {
                            return sat.nStates
                                .slice(Math.abs(stateIndex) - 500, Math.abs(stateIndex))
                                .map(s => getCartesian(s));
                        }
                    }, false),
                    width: 2,
                    material: Color.CYAN, // Orbit track color
                }
            });
        }
    }, [satelliteRef.current?.states])

    return null;
}